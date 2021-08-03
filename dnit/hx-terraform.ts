// Tasks from 'hx-terraform' ie generating providers and generating terraform

import { runAlways, asyncFiles, runConsole, Task, TrackedFile, trackFile, path, task } from './deps.ts'
import type { TasksObject } from "./types.ts";
import { rglobfiles } from './filesystem.ts';

import {ROOT} from './workingDir.ts'

/// Manifests help dependency tracking
// changes to backend result in re-run of terraform init
// changes to backend and providers result in re-run of terraform init
export type Manifests = {
  adhoc: TrackedFile;
  backend: TrackedFile;
  providers: TrackedFile;
  resources: TrackedFile;
};

export interface HxTerraformTasks extends TasksObject {
  tasks: {
    generateProviders: Task;
    generateTerraform: Task;
    generate: Task;
  },
  generatedProviderSrcs: TrackedFile[];
  manifests: Manifests;
};

export async function makeHxTerraformTasks(params: {}) : Promise<HxTerraformTasks> {

  // typescript terraform providers generated:
  const generatedProviderSrcs = [
    trackFile(
      path.join(ROOT, 'gen-terraform/hx-terraform/providers/aws/resources.ts')),
    trackFile(
      path.join(ROOT, 'gen-terraform/hx-terraform/providers/random/resources.ts')
    ),
  ];

  const generateProviders = task({
    name: 'generateProviders',
    description: 'Generate typescript for providers',
    action: async () => {
      await runConsole(
        ['deno', 'run', '--quiet', '--allow-read', '--allow-write', '--unstable', 'hx-terraform/tools/gen-providers.ts'],
        {
          cwd: path.join(ROOT, 'gen-terraform'),
        }
      );
    },
    deps: [
      trackFile(path.join(ROOT, 'gen-terraform/hx-terraform/tools/gen-helpers.ts')),
      trackFile(path.join(ROOT, 'gen-terraform/hx-terraform/tools/gen-providers.ts')),

      asyncFiles(async ()=>{
        // all provider sources other than (the generated) resources.ts
        const providers = await rglobfiles(path.join(ROOT, 'gen-terraform/hx-terraform/providers'), {
          skip: [/.*resources.ts/],
        });
        return providers.map(trackFile)
      })
    ],
    targets: generatedProviderSrcs
  });

  const manifests : Manifests = {
    adhoc: trackFile(path.join(ROOT, 'terraform/.manifest.adhoc')),
    backend: trackFile(path.join(ROOT, 'terraform/.manifest.backend')),
    providers: trackFile(path.join(ROOT, 'terraform/.manifest.providers')),
    resources: trackFile(path.join(ROOT, 'terraform/.manifest.resources')),
  };

  const generateTerraform = task({
    name: 'generateTerraform',
    description: 'Generate terraform files from the terraform EDSL',
    action: async () => {
      await runConsole(
      ['deno', 'run', '--quiet', '--allow-read', '--allow-write', '--unstable', 'main.ts'],
      {
        cwd: path.join(ROOT, 'gen-terraform'),
      });
    },
    deps: [
      generateProviders,
      ...generatedProviderSrcs,
      asyncFiles(async ()=>{
        // all typescript sources excl node_modules
        const sources = await rglobfiles(path.join(ROOT, 'gen-terraform'), {
          skip: [/node_modules/, /gen-terraform\/build/],
        });
        return sources.map(trackFile)
      })
    ],
    targets: Object.values(manifests),
  });

  const generate = task({
    name: 'generate',
    description: 'Alias of generateTerraform',
    action: async () => {
    },
    deps: [
      generateTerraform
    ]
  });

  return {
    tasks: {
      generateProviders,
      generateTerraform,
      generate
    },
    generatedProviderSrcs,
    manifests
  };
}
