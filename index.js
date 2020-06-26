const core = require('@actions/core');
const github = require('@actions/github');
const yaml = require('js-yaml');

const { promises: fs } = require('fs');

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

  return Array.from(teams).concat(Array.from(externalCollaborators));
}

async function run() {
  try {
    const { GITHUB_TOKEN } = process.env;
    const octokit = github.getOctokit(GITHUB_TOKEN);

    const config = await fs.readFile('config.yaml', 'utf8');
    const raw = yaml.safeLoad(config);

    const govMembers = parseGovernanceMembers(raw);
    for (const username of govMembers) {
      const { data: ghUser } = await octokit.users.getByUsername({ username });

      if (ghUser.status === 404) {
        core.setFailed(`No user with login ${username} exists on GitHub`);
        return;
      }

      if (ghUser.login !== username) {
        core.setFailed(
          `Governance member ${username} does not match GitHub login ${ghUser.login}`,
        );
        return;
      }
    }
  } catch (error) {
    console.error(error);
  }
}

run();
