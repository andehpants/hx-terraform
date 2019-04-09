import * as TF from '../../core/core';
import * as AT from '../../providers/aws/types';
import * as AR from '../../providers/aws/resources';

import * as aws from './aws';
import * as roles from './roles';
import * as shared from './shared';
import * as s3 from './s3';
import * as bootscript from '../bootscript';
import * as policies from './policies';
import * as docker from '../docker';
import * as deploytool from '../deploytool/deploytool';
import * as C from "../../library/deploytool/adl-gen/config";

import { EndPoint, getDefaultAmi, httpsFqdnsFromEndpoints } from './ec2-deployment';
import { createAutoscalingGroup, createLaunchConfiguration, createAutoscalingAttachment, createLb, createLbTargetGroup } from '../../providers/aws/resources';
import { contextTagsWithName, Customize, applyCustomize } from '../util';

/**
 *  Creates a logical deployment on an aws EC2 autoscaling group, including:
 *
 *      - the autoscale group itelf
 *      - AWS generated SSL certificates
 *      - DNS entries for the endpoints
 *      - Load balancer in front of autoscaling group
 *
 * hx-deploy-tool is configured onto the group, running in remote proxy mode.
 */
export function createAutoscaleDeployment(
  tfgen: TF.Generator,
  name: string,
  sr: shared.SharedResources,
  params: AutoscaleDeploymentParams
): AutoscaleDeployment {

  const controller = createController(tfgen, name, sr, params);
  const appserverAutoScaleGroup = createAppserverAutoScaleGroup(tfgen, name, sr, params);
  const appserverLoadBalancer = createAppserverLoadBalancer(tfgen, name, sr, params, appserverAutoScaleGroup);

  return {
    autoscaling_group: appserverAutoScaleGroup,
    target_group: appserverLoadBalancer.target_group,
    load_balancer: appserverLoadBalancer.load_balancer
  };
}

function createController(
  tfgen: TF.Generator,
  name: string,
  sr: shared.SharedResources,
  params: AutoscaleDeploymentParams
) {
  const app_user = appUserOrDefault(params.app_user);
  const releases_s3 = params.releases_s3;
  const state_s3 = params.state_s3;
  const controller_label = controllerLabel(params.controller_label);
  const subnetId = externalSubnetId(sr.network);

  const deploy_contexts: C.DeployContext[] = params.controller_deploy_contexts || [];

  const proxy_endpoints = deployToolEndpoints(sr, params.endpoints);

  // Build the bootscript for the controller
  const bs = bootscript.newBootscript();
  bs.utf8Locale();
  bs.createUserWithKeypairAccess( app_user);
  bs.extendUserShellProfile(app_user, 'PATH="/opt/bin:$PATH"');

  if (params.controller_extra_bootscript) {
    bs.include(params.controller_extra_bootscript);
  }

  bs.include(
    deploytool.install(
      app_user,
      releases_s3,
      deploy_contexts,
      deploytool.remoteProxyMaster(proxy_endpoints, state_s3),
    )
  );

  const controller_iampolicies = [
    aws.s3DeployBucketModifyPolicy(sr)
  ];

  const controller_instance_profile = roles.createInstanceProfileWithPolicies(
    tfgen,
    controller_label,
    controller_iampolicies
  );

  const controller = aws.createInstanceWithEip(tfgen, controller_label, sr, {
    instance_type: AT.t2_micro,
    ami: params.controller_amis || getDefaultAmi,
    security_group: sr.bastion_security_group,
    key_name: params.key_name,
    customize_instance: (i: AR.InstanceParams) => {
      i.user_data = bs.compile();
      i.iam_instance_profile = controller_instance_profile.id;
      i.subnet_id = subnetId;
    },
  });

  const controller_route53 = shared.dnsARecord(tfgen, controller_label, sr, params.controller_dns_name, [controller.eip.public_ip], "3600");

  return {};
}

function createAppserverAutoScaleGroup(
  tfgen: TF.Generator,
  name: string,
  sr: shared.SharedResources,
  params: AutoscaleDeploymentParams): AR.AutoscalingGroup {

  const app_user = appUserOrDefault(params.app_user);
  const docker_config = params.docker_config || docker.DEFAULT_CONFIG;
  const state_s3 = params.state_s3;
  const deploy_contexts: C.DeployContext[] = params.appserver_deploy_contexts || [];
  const endpoints: EndPoint[] = params.endpoints;
  const proxy_endpoints = deployToolEndpoints(sr, endpoints);

  // Build the bootscript for the instance
  const bs = bootscript.newBootscript();

  bs.utf8Locale();
  bs.dockerWithConfig(docker_config);
  bs.createUserWithKeypairAccess(app_user);
  bs.extendUserShellProfile(app_user, 'PATH="/opt/bin:$PATH"');
  bs.addUserToGroup(app_user, 'docker');
  bs.cloudwatchMetrics(app_user);
  if (params.appserver_extra_bootscript) {
    bs.include(params.appserver_extra_bootscript);
  }

  bs.include(
    deploytool.install(
      app_user,
      params.releases_s3,
      deploy_contexts,
      deploytool.remoteProxySlave(proxy_endpoints, state_s3),
    )
  );

  let appserver_iampolicies = [
    policies.publish_metrics_policy,
    aws.s3DeployBucketModifyPolicy(sr),
    policies.route53ModifyZonePolicy('modifydns', sr.primary_dns_zone),
    policies.ecr_readonly_policy
  ];
  if (params.appserver_extra_policies) {
    appserver_iampolicies = appserver_iampolicies.concat(params.appserver_extra_policies);
  }

  const appserver_instance_profile = roles.createInstanceProfileWithPolicies(
    tfgen,
    'appserver',
    appserver_iampolicies
  );

  const launch_config = createLaunchConfiguration(tfgen, "appserver", {
      name_prefix: tfgen.scopedName(name).join('-') + '-',
      key_name: params.key_name,
      image_id: (params.appserver_amis) ? params.appserver_amis(sr.network.region) : getDefaultAmi(sr.network.region),
      instance_type: params.appserver_instance_type,
      iam_instance_profile: appserver_instance_profile.id,
      security_groups: [sr.appserver_security_group.id],
      user_data: bs.compile(),
      root_block_device: {
        volume_size: 20
      },
  });

  tfgen.createBeforeDestroy(launch_config, true);

  const autoscaling_group = createAutoscalingGroup(tfgen, "appserver", {
    name: tfgen.scopedName(name).join('-'),
    min_size: params.min_size || 1,
    max_size: params.max_size || 1,
    vpc_zone_identifier: sr.network.azs.map(az => az.internal_subnet.id),
    launch_configuration: launch_config.name,
    tags: Object.entries(contextTagsWithName(tfgen, name)).map(([key, value]) => { // note that tag and tags parameters appear to have the same function
      return {
        key,
        value,
        propagate_at_launch: true
      }
    })
  });

  return autoscaling_group;
}

export type LoadBalancerResources = {
  load_balancer: AR.Lb;
  target_group: AR.LbTargetGroup;
}

function createAppserverLoadBalancer(
  tfgen: TF.Generator,
  name: string,
  sr: shared.SharedResources,
  params: AutoscaleDeploymentParams,
  autoscaling_group: AR.AutoscalingGroup): LoadBalancerResources {

  const https_fqdns: string[] = httpsFqdnsFromEndpoints(sr, params.endpoints);

  const albParams: AR.LbParams = {
    name: tfgen.scopedName(name).join('-'),
    load_balancer_type: 'application',
    tags: tfgen.tagsContext(),
    security_groups: [sr.load_balancer_security_group.id],
    subnets: sr.network.azs.map(az => az.external_subnet.id),
  };
  const alb = createLb(tfgen, "alb", applyCustomize(params.customize_lb, albParams));

  const alb_target_group = createLbTargetGroup(tfgen, "tg80", {
    port: 80,
    protocol: 'HTTP',
    vpc_id: sr.network.vpc.id,
    health_check: {
      path: '/health-check'
    },
    tags: tfgen.tagsContext()
  });

  const autoscaling_attachment = createAutoscalingAttachment(tfgen, "appserver", {
    autoscaling_group_name: autoscaling_group.id,
    alb_target_group_arn: alb_target_group.arn
  });

  // Create a new certificate if an existing certificate ARN isn't provided.
  // When new domains are added, the certificate is deleted and re-created, in this situation,
  // we need the certificate to be created first (as it can't be deleted while connectec to an ALB)
  const acm_certificate_arn = params.acm_certificate_arn != undefined ?
    params.acm_certificate_arn : createAcmCertificate(tfgen, sr, https_fqdns, true /* create before destroy */ );

  const alb_http_listener = AR.createLbListener(tfgen, "http", {
    load_balancer_arn: alb.arn,
    port: 80,
    protocol: "HTTP",
    default_action: {
      type: 'redirect',
      redirect: {
        protocol: 'HTTPS',
        port: '443',
        status_code: 'HTTP_301'
      },
    }
  });

  const alb_https_listener = AR.createLbListener(tfgen, "https", {
    load_balancer_arn: alb.arn,
    port: 443,
    protocol: 'HTTPS',
    certificate_arn: acm_certificate_arn,
    default_action: {
      type: 'forward',
      target_group_arn: alb_target_group.arn,
    }
  });

  params.endpoints.forEach(ep => {
    ep.urls.forEach( (url,i) => {
      if (url.kind == 'https') {
        shared.dnsAliasRecord(
          tfgen,
          'appserver_lb_' + ep.name + "_" + i,
          sr,
          url.dnsname,
          {
            name: alb.dns_name,
            zone_id: alb.zone_id,
            evaluate_target_health: true
          }
      );
      }
    });
  });

  return {
    load_balancer: alb,
    target_group: alb_target_group
  };
}

function createAcmCertificate(
  tfgen: TF.Generator,
  sr: shared.SharedResources,
  https_fqdns: string[],
  create_before_destroy: boolean
): AR.AcmCertificateArn {
  const acm_certificate = AR.createAcmCertificate(tfgen, 'cert', {
    domain_name: https_fqdns[0],
    subject_alternative_names: https_fqdns.slice(1),
    validation_method: 'DNS',
    tags: tfgen.tagsContext(),
  });
  tfgen.createBeforeDestroy(acm_certificate, create_before_destroy);

  const arn = acm_certificate.arn;
  const r53rs = https_fqdns.map((fqdn, i) => {

    const domain_validation_options = domainValidationOptions(acm_certificate, i);
    return AR.createRoute53Record(tfgen, "cert" + i, {
      zone_id: sr.primary_dns_zone.zone_id,
      name: domain_validation_options.name,
      type: domain_validation_options.type,
      ttl: "60",
      records: [domain_validation_options.value]
    });
  });

  const acm_certificate_validation = AR.createAcmCertificateValidation(tfgen, "cert", {
    certificate_arn: acm_certificate.arn,
    validation_record_fqdns: r53rs.map(r53r => r53r.fqdn)
  });

  return arn;
}

type DNSRecordType = 'A' | 'AAAA' | 'CAA' | 'CNAME' | 'MX' | 'NAPTR' | 'NS' | 'PTR' | 'SOA' | 'SPF' | 'SRV' | 'TXT';

interface DomainValidationOptions {
  name: string,
  type: DNSRecordType,
  value: string
}

function domainValidationOptions(acm_certificate: AR.AcmCertificate, i: number): DomainValidationOptions {
  return {
    name: "${aws_acm_certificate." + acm_certificate.tfname.join("_") + '.domain_validation_options.' + i + '.resource_record_name}',
    type: "${aws_acm_certificate." + acm_certificate.tfname.join("_") + '.domain_validation_options.' + i + '.resource_record_type}' as DNSRecordType,
    value: "${aws_acm_certificate." + acm_certificate.tfname.join("_") + '.domain_validation_options.' + i + '.resource_record_value}'
  }
}

function appUserOrDefault(app_user?: string): string {
  return app_user || 'app';
}

function externalSubnetId(network: shared.NetworkResources): SubnetId {
  return network.azs.map(az => az.external_subnet.id)[0]
}

function deployToolEndpoints(sr: shared.SharedResources, endpoints: EndPoint[]): C.EndPoint[] {
  return endpoints.map(ep => {
    const fqdns = ep.urls.map( url => {
        if (url.kind === 'https') {
          return (shared.fqdn(sr, url.dnsname));
        } else if (url.kind === 'https-external') {
          return (url.fqdnsname);
        } else {
          return (url.fqdnsname);
        }
    });
    return deploytool.httpProxyEndpoint(ep.name, fqdns);
  });
}

function controllerLabel(label?: string) {
  return label || "controller";
}


type SubnetId = {type:'SubnetId',value:string};

interface AutoscaleDeploymentParams {
  /**
   * The AWS keyname used for the EC2 instance.
   */
  key_name: AT.KeyName;

  /**
   * The DNS name of the controller machine. This is a prefix to the shared primary DNS zone.
   * (ie if the value is aaa and the primary dns zone is helix.com, then the final DNS entry
   * will be aaa.helix.com).
   */
  controller_dns_name: string;

  /**
   * The S3 location where hx-deploy-tool releases are stored.
   */
  releases_s3: s3.S3Ref;

  /**
   * The S3 location where hx-deploy-tool keeps it's state information
   */
  state_s3: s3.S3Ref;

  /**
   * The name of the unprivileged user used to run application code.
   * Defaults to "app".
   */
  app_user?: string;

  /**
   * The endpoints configured for http/https access.
   */
  endpoints: EndPoint[];

  /**
   * Additional operations for the controller first boot can be passed vis the operation.
   */
  controller_extra_bootscript?: bootscript.BootScript;

  /**
   * Specifies the AMI for the controller. Defaults to an ubuntu 16.04 AMI
   * for the appropriate region.
   */
  controller_amis?(region: AT.Region): AT.Ami;

  /**
   * The context files are fetched from S3 and made available to the controller instance for
   * interpolation into the deployed application configuration.
   */
  controller_deploy_contexts?: C.DeployContext[];

  /**
   * Label the deploy master instance and associated resources for client convenience
   */
  controller_label?: string;

  /**
   * Additional operations for the EC2 instances first boot can be passed vis the operation.
   */
  appserver_extra_bootscript?: bootscript.BootScript;

  /**
   * The AWS instance type (ie mem and cores) for the EC2 instance.
   */
  appserver_instance_type: AT.InstanceType;

  /**
   * Specifies the AMI for the EC2 instances. Defaults to an ubuntu 16.04 AMI
   * for the appropriate region.
   */
  appserver_amis?(region: AT.Region): AT.Ami;

  /**
   * The context files are fetched from S3 and made available to hx-deploy-tool for interpolation
   * into the deployed application configuration.
   */
  appserver_deploy_contexts?: C.DeployContext[];

  /**
   * The EC2 instance created is given an IAM profile with sufficient access policies to
   * log metrics, run the deploy tool and create SSL certificates. Additional policies
   * can be specified here.
   */
  appserver_extra_policies?: policies.NamedPolicy[];

  /** Lower bound of EC2 instances for the Autoscaling group */
  min_size?: number;

  /** Upper bound of EC2 instances for the Autoscaling group */
  max_size?: number;

  /**
   * Override the default docker config.
   */
  docker_config?: docker.DockerConfig;

  /**
   * Use this AWS ACM certificate rather than automatically generating one
   */
  acm_certificate_arn?: AR.AcmCertificateArn;

  /**
   * Customise underlying load balancer (if required)
   * https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html
   */
  customize_lb?: Customize<AR.LbParams>
}

interface AutoscaleDeployment {
  autoscaling_group: AR.AutoscalingGroup;
  target_group: AR.LbTargetGroup;
  load_balancer: AR.Lb;
}