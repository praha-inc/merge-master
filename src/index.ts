import * as core from '@actions/core';
import * as github from '@actions/github';
import { print } from 'graphql';
import { gql } from 'graphql-tag';

import type { PullRequest as PullRequestTypedef } from '@octokit/graphql-schema';

type PullRequest = Omit<PullRequestTypedef, 'labels'> & {
  id: PullRequestTypedef['id'];
  title: PullRequestTypedef['title'];
  author: NonNullable<PullRequestTypedef['author']>;
  labels: { nodes: { name: string }[] };
  number: PullRequestTypedef['number'];
  isDraft: PullRequestTypedef['isDraft'];
  mergeStateStatus: PullRequestTypedef['mergeStateStatus'];
  mergeable: PullRequestTypedef['mergeable'];
  autoMergeRequest: NonNullable<PullRequestTypedef['autoMergeRequest']>;
  statusCheckRollup: NonNullable<PullRequestTypedef['statusCheckRollup']>;
};

type GraphqlResponse = {
  repository: {
    pullRequests: {
      nodes: PullRequest[];
    };
  };
};

const run = async (): Promise<void> => {
  try {
    const token = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);

    const externalRebaseAuthors = core.getInput('external-rebase-authors')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const isExternalRebaseAuthor = (login: string) => externalRebaseAuthors.includes(login.toLowerCase());

    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    const { data: { default_branch: defaultBranch } } = await octokit.rest.repos.get({ owner, repo });

    const query = gql`
      query($owner: String!, $repo: String!, $defaultBranch: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(baseRefName: $defaultBranch, first: 100, states: OPEN, orderBy: { field: CREATED_AT, direction: ASC }) {
            nodes {
              id
              title
              author { login }
              labels(first: 100) { nodes { name } }
              number
              isDraft
              mergeStateStatus
              mergeable
              autoMergeRequest { enabledAt }
              statusCheckRollup { state }
            }
          }
        }
      }
    `;

    const targetPRs: PullRequest[] = await octokit.graphql<GraphqlResponse>(print(query), { owner, repo, defaultBranch })
      .then((resp) =>
        resp.repository.pullRequests.nodes.filter((pr) =>
          [
            pr.autoMergeRequest,
            pr.mergeable === 'MERGEABLE' || (isExternalRebaseAuthor(pr.author.login) && pr.mergeable === 'CONFLICTING'),
            pr.statusCheckRollup && pr.statusCheckRollup.state !== 'FAILURE',
            !pr.isDraft,
          ].every(Boolean),
        ),
      );

    if (targetPRs.length === 0) {
      core.info('No PRs to update');
      return;
    }

    if (targetPRs.some((pr) => pr.statusCheckRollup.state === 'PENDING' && pr.mergeStateStatus !== 'BEHIND')) {
      core.info('There is a PR that is following the base branch and CI is running');
      return;
    }

    const targetPR = targetPRs.find((pr) => !isExternalRebaseAuthor(pr.author.login)) || targetPRs[0]!;

    if (isExternalRebaseAuthor(targetPR.author.login)) {
      core.info(`External rebase PR: ${targetPR.number}`);
      if (targetPR.labels.nodes.some(({ name }) => name === 'rebase')) {
        core.info('This PR is already rebasing');
        return;
      }
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: targetPR.number,
        labels: ['rebase'],
      });
    } else {
      core.info(`Update branch of PR: ${targetPR.number}`);
      await octokit.rest.pulls.updateBranch({
        owner,
        repo,
        pull_number: targetPR.number,
      });
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
};

void run();
