/*
* cmd.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { existsSync } from "fs/mod.ts";

import { Command } from "cliffy/command/mod.ts";
import { Select } from "cliffy/prompt/select.ts";
import { prompt } from "cliffy/prompt/mod.ts";

import {
  AccountToken,
  findProvider,
  kPublishProviders,
  PublishProvider,
} from "../../publish/provider.ts";

import { initYamlIntelligenceResourcesFromFilesystem } from "../../core/schema/utils.ts";
import {
  initState,
  setInitializer,
} from "../../core/lib/yaml-validation/state.ts";
import {
  projectContext,
  projectIsWebsite,
} from "../../project/project-context.ts";

import { PublishCommandOptions } from "./options.ts";
import { resolveDeployment } from "./deployment.ts";
import { AccountPrompt, resolveAccount } from "./account.ts";

import { PublishOptions, PublishRecord } from "../../publish/types.ts";
import { isInteractiveTerminal } from "../../core/platform.ts";
import { runningInCI } from "../../core/ci-info.ts";
import { ProjectContext } from "../../project/types.ts";
import { openUrl } from "../../core/shell.ts";
import { publishDocument, publishSite } from "../../publish/publish.ts";
import { handleUnauthorized } from "../../publish/account.ts";

export const publishCommand = withProviders(
  // deno-lint-ignore no-explicit-any
  new Command<any>()
    .name("publish")
    .hidden()
    .description(
      "Publish a document or project to a variety of destinations.",
    )
    .arguments("[path:string]")
    .option(
      "--no-render",
      "Do not render before publishing.",
      { global: true },
    )
    .option(
      "--no-prompt",
      "Do not prompt to confirm publishing destination",
      { global: true },
    )
    .option(
      "--no-browser",
      "Do not open a browser to the site after publishing",
      { global: true },
    )
    .option(
      "--site-id <id:string>",
      "Identifier of site to publish",
      { global: true },
    )
    .action(async (options: PublishCommandOptions, path?: string) => {
      await publishAction(options, path);
    }),
);

async function publishAction(
  options: PublishCommandOptions,
  path?: string,
  provider?: PublishProvider,
) {
  await initYamlIntelligence();

  // coalesce options
  const publishOptions = await createPublishOptions(options, path);

  // helper to publish (w/ account confirmation)
  const doPublish = async (
    publishProvider: PublishProvider,
    accountPrompt: AccountPrompt,
    publishTarget?: PublishRecord,
  ) => {
    const account = await resolveAccount(
      publishProvider,
      publishOptions.prompt ? accountPrompt : "never",
    );
    if (account) {
      await publish(
        publishProvider,
        account,
        publishOptions,
        publishTarget,
      );
    }
  };

  // see if we are redeploying
  const deployment = await resolveDeployment(
    publishOptions,
    provider?.name,
  );
  if (deployment) {
    // existing deployment
    await doPublish(deployment.provider, "multiple", deployment.target);
  } else if (publishOptions.prompt) {
    // new deployment, determine provider if needed
    if (!provider) {
      // select provider
      const result = await prompt([{
        indent: "",
        name: "provider",
        message: "Provider:",
        options: kPublishProviders.map((provider) => ({
          name: provider.description,
          value: provider.name,
        })),
        type: Select,
      }]);
      if (result.provider) {
        provider = findProvider(result.provider);
      }
    }
    if (provider) {
      await doPublish(provider, "always");
    }
  } else {
    throw new Error(
      "No re-publishing target found (--no-prompt requires an existing 'publish' config to update)",
    );
  }
}

async function publish(
  provider: PublishProvider,
  account: AccountToken,
  options: PublishOptions,
  target?: PublishRecord,
): Promise<void> {
  try {
    const siteUrl = typeof (options.input) !== "string"
      ? await publishSite(
        options.input,
        provider,
        account,
        options,
        target,
      )
      : await publishDocument(
        options.input,
        provider,
        account,
        options,
        target,
      );

    // open browser if requested
    if (options.browser) {
      await openUrl(siteUrl.toString());
    }
  } catch (err) {
    // attempt to recover from unauthorized
    if (provider.isUnauthorized(err) && options.prompt) {
      if (await handleUnauthorized(provider, account)) {
        const authorizedAccount = await provider.authorizeToken();
        if (authorizedAccount) {
          // recursve after re-authorization
          return await publish(provider, authorizedAccount, options, target);
        }
      }
    } else {
      throw err;
    }
  }
}

async function createPublishOptions(
  options: PublishCommandOptions,
  path?: string,
): Promise<PublishOptions> {
  // validate path exists
  path = path || Deno.cwd();
  if (!existsSync(path)) {
    throw new Error(
      `The specified path (${path}) does not exist so cannot be published.`,
    );
  }
  // determine publish input
  let input: ProjectContext | string;

  // check for website project
  const project = await projectContext(path);
  if (Deno.statSync(path).isDirectory) {
    if (!project || !projectIsWebsite(project)) {
      throw new Error(
        `The specified path (${path}) is not a website or book project so cannot be published.`,
      );
    }
    input = project;
  } // single file path
  else {
    // if there is a project associated with this file then it can't be a website or book
    if (project && projectIsWebsite(project)) {
      throw new Error(
        `The specified path (${path}) is within a website or book project so cannot be published individually`,
      );
    }
    input = path;
  }

  const interactive = isInteractiveTerminal() && !runningInCI();
  return {
    input,
    render: !!options.render,
    prompt: !!options.prompt && interactive,
    browser: !!options.browser && interactive,
    siteId: options.siteId,
  };
}

function withProviders(
  command: Command<PublishCommandOptions>,
): Command<PublishCommandOptions> {
  for (const provider of kPublishProviders) {
    command.command(
      provider.name,
      new Command<PublishCommandOptions>()
        .name(provider.name)
        .description(provider.description)
        .action(async (options: PublishCommandOptions, path?: string) => {
          await publishAction(options, path, provider);
        }),
    );
  }
  return command;
}

async function initYamlIntelligence() {
  setInitializer(initYamlIntelligenceResourcesFromFilesystem);
  await initState();
}
