const core = require('@actions/core');
const github = require('@actions/github');
const yaml = require('js-yaml');

const fs = require('fs');
const path = require('path');

function parseGovernanceMembers(rawJson) {
  const teams = new Set(
    [].concat.apply(
      [],
      rawJson.teams.map((team) => {
        const members = team.members || [];
        const maintainers = team.maintainers || [];
        return members.concat(maintainers);
      }),
    ),
  );

  return teams;
}

function parseGovernanceCollaborators(rawJson) {
  const externalCollaborators = new Set(
    [].concat.apply(
      [],
      rawJson.repositories.map((repo) => {
        const collabsObj = repo.external_collaborators || {};
        const collabs = Object.keys(collabsObj);
        return collabs;
      }),
    ),
  );

  return externalCollaborators;
}

const hasMaintainers = (team) => {
  return (
    team.maintainers !== undefined &&
    Array.isArray(team.maintainers) &&
    team.maintainers.length !== 0
  );
};

async function run() {
  try {
    const { GITHUB_TOKEN, GITHUB_WORKSPACE, ORG_TOKEN } = process.env;
    const octokit = github.getOctokit(GITHUB_TOKEN);
    const orgOctokit = github.getOctokit(ORG_TOKEN);

    const pathToFile = path.join(GITHUB_WORKSPACE, 'config.yaml');
    if (!fs.existsSync(pathToFile)) {
      core.setFailed('config.yaml not found');
      return;
    }

    const config = await fs.promises.readFile(pathToFile, 'utf8');
    const raw = yaml.safeLoad(config);

    // Check that each GitHub team has a maintainer.
    for (const team of raw.teams) {
      if (team.name !== 'gov' && !hasMaintainers(team)) {
        core.setFailed(
          `GitHub team ${team.name} does not have valid maintainer(s)`,
        );
        return;
      }
    }

    core.info(`Audited ${raw.teams.length} GitHub teams successfully`);

    const govMembers = parseGovernanceMembers(raw);
    const govCollaborators = parseGovernanceCollaborators(raw);
    const allGovMembers = Array.from(govMembers).concat(
      Array.from(govCollaborators),
    );

    const ghOrgMembers = await orgOctokit.paginate(
      orgOctokit.orgs.listMembers.endpoint.merge({
        org: raw.organization,
      }),
    );

    // Check that governance members are valid.
    for (const username of allGovMembers) {
      const { data: ghUser, status } = await octokit.users.getByUsername({
        username,
      });

      if (status === 404) {
        core.setFailed(`No user with login ${username} exists on GitHub`);
        return;
      }

      if (ghUser.login !== username) {
        core.setFailed(
          `Governance member ${username} does not match GitHub login ${ghUser.login}`,
        );
        return;
      }

      if (
        govMembers.has(username) &&
        !ghOrgMembers.some((ghOrgMember) => ghOrgMember.login === username)
      ) {
        core.setFailed(
          `Governance member ${username} is not currently in the "${raw.organization}" GitHub org`,
        );
        return;
      }
    }

    core.info(`Audited ${govMembers.size} members successfully`);
  } catch (error) {
    console.error(error);
  }
}

run();
