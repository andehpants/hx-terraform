import * as AR from "../../providers/aws/resources.ts";
import { ArnSecret } from "./secrets.ts";

export interface NamedPolicy {
  name: string;
  policy: {
    Statement: Statement[],
    [key: string]: unknown;
  };
}

export interface Statement {
  Action: unknown;
  Effect: unknown;
  [key: string]: unknown;
}

export function newNamedPolicy(
  name: string,
  statements: Statement[],
): NamedPolicy {
  return {
    name,
    policy: {
      Version: "2012-10-17",
      Statement: statements,
    },
  };
}

export function combineNamedPolicies(
  name: string,
  namedPolicies: NamedPolicy[],
): NamedPolicy {
  const Statement: Statement[] = [];
  for (const np of namedPolicies) {
    Statement.push(...np.policy.Statement);
  }

  return {
    name,
    policy: {
      Version: "2012-10-17",
      Statement,
    },
  };
}


export function assumeServiceRole(Service: string): Statement[] {
  return [
    {
      Action: "sts:AssumeRole",
      Principal: { Service },
      Effect: "Allow",
      Sid: "",
    },
  ]
}

export function publishMetrics(): Statement[] {
  return [
    {
      Action: [
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics",
        "cloudwatch:PutMetricData",
        "ec2:DescribeTags",
      ],
      Effect: "Allow",
      Resource: "*",
    },
  ];
}

export function s3ReadonlyBuckets(
  buckets: string[],
  key_prefix: string = "*",
): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: buckets.map((bucket) => `arn:aws:s3:::${bucket}`),
    },
    {
      Action: ["s3:GetObject"],
      Effect: "Allow",
      Resource: buckets.map((bucket) => `arn:aws:s3:::${bucket}/${key_prefix}`),
    },
  ];
}

export function s3PublicReadonly(
  bucket: string,
  key_prefix: string = "*",
): Statement[] {
  return [
    {
      Action: ["s3:GetObject"],
      Effect: "Allow",
      Principal: "*",
      Resource: [`arn:aws:s3:::${bucket}/${key_prefix}`],
    },
  ];
}

export function s3WriteOnlyBuckets(
  bucket: string,
  key_prefix: string = "*",
): Statement[] {
  return [
    {
      Action: ["s3:PutObject"],
      Effect: "Allow",
      Principal: "*",
      Resource: [`arn:aws:s3:::${bucket}/${key_prefix}`],
    },
  ];
}

export function s3ModifyBuckets(
  buckets: string[],
  key_prefix: string = "*",
): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: buckets.map((bucket) => `arn:aws:s3:::${bucket}`),
    },
    {
      Action: [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject",
        "s3:GetObjectAcl",
        "s3:DeleteObject",
      ],
      Effect: "Allow",
      Resource: buckets.map((bucket) => `arn:aws:s3:::${bucket}/${key_prefix}`),
    },
  ];
}

export function putLogs(log_group: AR.CloudwatchLogGroup): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:DescribeLogStreams",
        "logs:PutLogEvents",
      ],
      Resource: [`${log_group.arn.value}`],
    },
  ];
}

export function putAnyLogs(): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:DescribeLogStreams",
        "logs:PutLogEvents",
      ],
      Resource: ["arn:aws:logs:*:*:*"],
    },
  ];
}

export function route53ModifyZone(zone: AR.Route53Zone): Statement[] {
  return [
    {
      Action: ["route53:*"],
      Effect: "Allow",
      Resource: [`arn:aws:route53:::hostedzone/${zone.zone_id.value}`],
    },
    {
      Action: ["route53:ListHostedZones", "route53:GetChange"],
      Effect: "Allow",
      Resource: ["*"],
    },
  ];
}

export function sqsQueueModify(queue: AR.SqsQueue): Statement[] {
  return [
    {
      Action: "sqs:*",
      Effect: "Allow",
      Resource: queue.arn.value,
    },
  ];
}

export function ecrReadonly(): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:GetRepositoryPolicy",
        "ecr:DescribeRepositories",
        "ecr:ListImages",
        "ecr:DescribeImages",
        "ecr:BatchGetImage",
      ],
      Resource: "*",
    },
  ];
}

export function ecrModifyAll(): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: ["ecr:*"],
      Resource: "*",
    },
  ];
}

export function lambdaInVpc(): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: [
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface",
      ],
      Resource: "*",
    },
  ];
}

export function edModify(
  esdomain: AR.ElasticsearchDomain,
): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: ["es:*"],
      Resource: `${esdomain.arn.value}/*`,
    },
  ];
}

export function secretReadOnly(
  arn: ArnSecret,
): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: "secretsmanager:GetSecretValue",
      Resource: `${arn.value}`,
    },
  ];
}

export function sesAllActions(): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: ["ses:*"],
      Resource: "*",
    },
  ];
}

export function firehosePutRecord(
  stream: AR.KinesisFirehoseDeliveryStream,
): Statement[] {
  return [
    {
      Effect: "Allow",
      Action: ["firehose:PutRecord", "firehose:PutRecordBatch"],
      Resource: stream.arn.value,
    },
  ];
}

export function autoscalingGroupEnableSetInstanceProtection(
  Resource: string,
): Statement[] {
  return [
    {
      // Customise Resource to restrict access
      Resource,
      Effect: "Allow",
      Action: "autoscaling:SetInstanceProtection",
    },
  ];
}

/**
 * Allow sending of SMS, but not sns messages to topics, etc.
 *
 * https://stackoverflow.com/questions/38871201/authorization-when-sending-a-text-message-using-amazonsnsclient
 */
export function snsPostSms(): Statement[] {
  return [
    {
      Effect: "Deny",
      Action: [
        "sns:Publish",
      ],
      Resource: "arn:aws:sns:*:*:*",
    },
    {
      Effect: "Allow",
      Action: [
        "sns:Publish",
      ],
      Resource: "*",
    },
  ];
}

/**
 * Full access to SNS
 */
export function snsFullAccess(): Statement[] {
  return [
    {
      "Action": [
        "sns:*",
      ],
      "Effect": "Allow",
      "Resource": "*",
    },
  ];
}
