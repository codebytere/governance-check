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

    const getTeamMembers = (team) => {
      if (team.formation) {
        return team.formation.reduce((allMembers, formationTeam) => {
          const team = raw.teams.find((team) => team.name === formationTeam);
          return allMembers.concat(getTeamMembers(team));
        }, []);
      }
      return [...(team.members || []), ...(team.maintainers || [])];
    };

    for (const team of raw.teams) {
      // Check that each GitHub team has a maintainer.
      if (!team.formation && !hasMaintainers(team)) {
        core.setFailed(
          `GitHub team ${team.name} does not have valid maintainer(s)`,
        );
        return;
      }

      // Check that maintainers are not duplicated in the members field
      if (hasMaintainers(team)) {
        const maintainerAndMember = team.maintainers.filter((maintainer) => {
          return team.members.includes(maintainer);
        });

        if (maintainerAndMember.length > 0) {
          core.setFailed(
            `GitHub team ${
              team.name
            } has one or more maintainers who are also duplicated as members: ${maintainerAndMember.join(
              ', ',
            )}`,
          );
          return;
        }
      }

      // Anyone in a child team, must also be in the parent team explicitly
      // to avoid unintended permission grants.
      let currentTeam = team;
      while (currentTeam.parent) {
        const parentTeam = raw.teams.find(
          (team) => team.name === currentTeam.parent,
        );
        if (!parentTeam) {
          core.setFailed(
            `GitHub team ${currentTeam.name} references a non-existent parent team ${currentTeam.parent}`,
          );
          return;
        }

        const currentTeamMembers = getTeamMembers(currentTeam);
        const parentTeamMembers = getTeamMembers(parentTeam);
        for (const member of currentTeamMembers) {
          if (!parentTeamMembers.includes(member)) {
            core.setFailed(
              `GitHub team ${currentTeam.name} has a member ${member} not in the parent team ${parentTeam.name}`,
            );
            return;
          }
        }

        currentTeam = parentTeam;
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
