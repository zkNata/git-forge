// rest.ts — the REST v3 surface (/api/v3), verified against the suite's checks
// (sdk/conformance/src/checks-rest.ts) and its RestClient (rest-client.ts).
//
// Wire rules the checks enforce (all verified in the kit, not assumed):
// - every reply is application/json and carries a non-empty X-GitHub-Request-Id;
// - errors are JSON {message: string}; unknown routes are 404 JSON; malformed JSON is 400;
// - the token's login owns every repo it creates; the same repo name under another
//   owner is a 404, never a 403; a missing repo is a 404;
// - contents file paths arrive with '/' encoded per segment (encodeSegment), so each
//   path segment is decoded separately — a path is never split on an encoded slash;
// - contents PUT commits are real git commits in the same object store the git
//   surface reads (blob sha == git blob sha, tree/commit visible to clone/fetch);
// - issues and pull requests share one per-repo number counter, starting at 1.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  globalId,
  isoFromEpochSec,
  isObjectId,
  parseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  /** The viewer login (adaiversen); the token's owner. */
  viewer: string;
  /** This server's origin (e.g. http://127.0.0.1:PORT), for absolute Link URLs. */
  origin: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const tip = store.branchTip(repo, repo.defaultBranch);
  return {
    id: repo.id,
    node_id: globalId('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoFromEpochSec(store.trialNowSec),
    updated_at: isoFromEpochSec(store.trialNowSec),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', `${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => ({ id: 0, node_id: globalId('L', `${repo.owner}/${repo.name}:${name}`), name, color: repo.labels.get(name)?.color ?? '000000', default: false, description: '' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: isoFromEpochSec(store.trialNowSec + issue.createdSeq),
    updated_at: isoFromEpochSec(store.trialNowSec + issue.createdSeq),
    closed_at: issue.state === 'closed' ? isoFromEpochSec(store.trialNowSec + issue.createdSeq) : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/repos/${repo.owner}/${repo.name}`,
    author_association: 'OWNER',
    milestone: null,
    pull_request: undefined,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('P', `${repo.owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    head: { label: `${repo.owner}:${pull.head.ref}`, ref: pull.head.ref, sha: pull.head.sha, user: { login: repo.owner, id: VIEWER_ID, type: 'User' }, repo: repoJson(store, repo) },
    base: { label: `${repo.owner}:${pull.base.ref}`, ref: pull.base.ref, sha: pull.base.sha, user: { login: repo.owner, id: VIEWER_ID, type: 'User' }, repo: repoJson(store, repo) },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.mergeable(repo, pull) === 'MERGEABLE' : null,
    mergeable_state: pull.state === 'open' ? (store.mergeable(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty') : 'unknown',
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: isoFromEpochSec(store.trialNowSec + pull.createdSeq),
    updated_at: isoFromEpochSec(store.trialNowSec + pull.createdSeq),
    closed_at: pull.state === 'closed' ? pull.merged_at : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    labels: [],
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function branchJson(store: Store, repo: Repo, branch: string, tip: string): Record<string, unknown> {
  return {
    name: branch,
    commit: { sha: tip, url: `/repos/${repo.owner}/${repo.name}/commits/${tip}` },
    protected: false,
  };
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(store.peelToCommit(repo, sha));
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  return {
    sha,
    node_id: globalId('C', `${repo.owner}/${repo.name}:${sha}`),
    commit: {
      message: parsed.message.replace(/\n+$/, ''),
      author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: isoFromEpochSec(store.trialNowSec) },
      committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: isoFromEpochSec(store.trialNowSec) },
      tree: { sha: parsed.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: parsed.parents.map((parent) => ({ sha: parent, url: `/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
    url: `/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

/** Split a decoded path into segments, decoding each one (the client encodes per segment). */
function decodeSegments(path: string): string[] {
  return path.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/** The page of repos the viewer owns, in creation order. */
function listUserRepos(ctx: RestContext, query: URLSearchParams): RestResult {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const repos = ctx.store.repoOrder.filter((repo) => repo.owner === ctx.viewer);
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages) {
    headers.Link = `<${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  return ok(200, slice.map((repo) => repoJson(ctx.store, repo)), headers);
}

export function handleRest(
  ctx: RestContext,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const store = ctx.store;
  const segments = decodeSegments(path.replace(/^\/+/, ''));
  const getBody = (): Record<string, unknown> => (body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {});
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

  // GET /api/v3 and /api/v3/ — the API root.
  if ((segments.length === 0 || (segments.length === 1 && segments[0] === '')) && method === 'GET') {
    return ok(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?repository_id={repository_id}&q={query}{&page,per_page}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/users/{user}/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return ok(200, {
      verifiable_password_authentication: true,
      installed_version: '3.12.0',
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      actions_macos: [],
      dependabot: [],
      domains: { website: [], codespaces: [], copilot: [], packages: [] },
    });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    return ok(200, {
      login: ctx.viewer,
      id: VIEWER_ID,
      node_id: globalId('U', ctx.viewer),
      avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
      gravatar_id: '',
      url: '/api/v3/users/' + ctx.viewer,
      html_url: `https://github.com/${ctx.viewer}`,
      type: 'User',
      site_admin: false,
      name: VIEWER_NAME,
      company: null,
      blog: '',
      location: null,
      email: `${VIEWER_LOGIN}@example.invalid`,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: store.repoOrder.filter((repo) => repo.owner === ctx.viewer).length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: isoFromEpochSec(store.trialNowSec),
      updated_at: isoFromEpochSec(store.trialNowSec),
    });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') return listUserRepos(ctx, query);
    if (method === 'POST') {
      const data = getBody();
      const name = str(data.name);
      if (name === undefined || name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
      if (store.getRepo(ctx.viewer, name) !== undefined) return err(422, 'name already exists on this account');
      const repo = store.createRepo(name, {
        private: data.private === true,
        description: str(data.description) ?? '',
        defaultBranch: str(data.default_branch) ?? 'main',
      });
      return ok(201, repoJson(store, repo));
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return err(404, 'Not Found');
    const rest = segments.slice(3);

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        const data = getBody();
        if (str(data.description) !== undefined) repo.description = str(data.description)!;
        if (data.private === true || data.private === false) repo.private = data.private;
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return ok(204, null);
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches: Record<string, unknown>[] = [];
      for (const ref of [...repo.refs.keys()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        const branch = ref.slice('refs/heads/'.length);
        branches.push(branchJson(store, repo, branch, repo.refs.get(ref)!));
      }
      return ok(200, branches);
    }

    // /repos/{owner}/{repo}/branches/{branch}
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const branch = rest[1]!;
      const tip = store.branchTip(repo, branch);
      if (tip === '') return err(404, 'Branch not found');
      return ok(200, branchJson(store, repo, branch, tip));
    }

    // /repos/{owner}/{repo}/commits[?sha=]
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const sha = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, sha);
      if (tip === '') return err(404, 'Not Found');
      const commits = store.commitList(repo, tip);
      return ok(200, commits.map((commit) => commitJson(store, repo, commit.sha)).filter((item) => item !== null));
    }

    // /repos/{owner}/{repo}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (tip === '') return err(404, 'Not Found');
        const files = store.filesAt(repo, tip);
        const direct = files.get(filePath);
        if (direct !== undefined) {
          const blob = repo.objects.get(direct.oid);
          const content = blob?.type === 'blob' ? blob.data : Buffer.alloc(0);
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: content.toString('base64'),
            sha: direct.oid,
            url: `/repos/${owner}/${repoName}/contents/${filePath}`,
            git_url: `/repos/${owner}/${repoName}/git/blobs/${direct.oid}`,
            html_url: `https://github.com/${owner}/${repoName}/blob/${ref}/${filePath}`,
            download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${ref}/${filePath}`,
            _links: { self: `/repos/${owner}/${repoName}/contents/${filePath}`, git: `/repos/${owner}/${repoName}/git/blobs/${direct.oid}`, html: `https://github.com/${owner}/${repoName}/blob/${ref}/${filePath}` },
          });
        }
        // A directory: its direct children.
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const children = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir' }>();
        for (const [path, value] of files) {
          if (!path.startsWith(prefix)) continue;
          const restPath = path.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash < 0) {
            children.set(restPath, { name: restPath, path, sha: value.oid, type: 'file' });
          } else {
            const dir = restPath.slice(0, slash);
            if (!children.has(dir)) children.set(dir, { name: dir, path: `${prefix}${dir}`, sha: '', type: 'dir' });
          }
        }
        if (children.size === 0) return err(404, 'Not Found');
        const entries = [...children.values()]
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((child) => ({
            type: child.type,
            size: child.type === 'file' ? (repo.objects.get(child.sha)?.data.length ?? 0) : 0,
            name: child.name,
            path: child.path,
            sha: child.sha,
            url: `/repos/${owner}/${repoName}/contents/${child.path}`,
            git_url: `/repos/${owner}/${repoName}/git/blobs/${child.sha}`,
            html_url: `https://github.com/${owner}/${repoName}/tree/${ref}/${child.path}`,
            download_url: child.type === 'file' ? `https://raw.githubusercontent.com/${owner}/${repoName}/${ref}/${child.path}` : null,
            _links: { self: `/repos/${owner}/${repoName}/contents/${child.path}`, git: `/repos/${owner}/${repoName}/git/blobs/${child.sha}`, html: `https://github.com/${owner}/${repoName}/tree/${ref}/${child.path}` },
          }));
        return ok(200, entries);
      }
      if (method === 'PUT' || method === 'DELETE') {
        const data = getBody();
        const message = str(data.message) ?? (method === 'PUT' ? `Update ${filePath}` : `Delete ${filePath}`);
        const branch = str(data.branch) ?? repo.defaultBranch;
        if (method === 'PUT') {
          const content = str(data.content);
          if (content === undefined) return err(422, 'content is required');
          let bytes: Buffer;
          try {
            bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
          } catch {
            return err(400, 'content is not valid base64');
          }
          const result = store.commitFile(repo, { branch, path: filePath, content: bytes, message, sha: str(data.sha) });
          if ('error' in result) return err(result.status, result.error);
          return ok(result.created ? 201 : 200, {
            content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: result.contentSha, size: bytes.length, url: `/repos/${owner}/${repoName}/contents/${filePath}`, git_url: `/repos/${owner}/${repoName}/git/blobs/${result.contentSha}`, html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${filePath}`, download_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${filePath}`, type: 'file', encoding: 'base64' },
            commit: { sha: result.commitSha, node_id: globalId('C', `${owner}/${repoName}:${result.commitSha}`), message, author: { name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid`, date: isoFromEpochSec(store.trialNowSec) }, committer: { name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid`, date: isoFromEpochSec(store.trialNowSec) }, url: `/repos/${owner}/${repoName}/commits/${result.commitSha}`, html_url: `https://github.com/${owner}/${repoName}/commit/${result.commitSha}` },
          });
        }
        const result = store.deleteFile(repo, { branch, path: filePath, message, sha: str(data.sha) });
        if ('error' in result) return err(result.status, result.error);
        return ok(200, {
          commit: { sha: result.commitSha, node_id: globalId('C', `${owner}/${repoName}:${result.commitSha}`), message, author: { name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid`, date: isoFromEpochSec(store.trialNowSec) }, committer: { name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid`, date: isoFromEpochSec(store.trialNowSec) }, url: `/repos/${owner}/${repoName}/commits/${result.commitSha}`, html_url: `https://github.com/${owner}/${repoName}/commit/${result.commitSha}` },
        });
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/git/refs[/{ref...}]
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
      const refPath = rest.slice(2).join('/');
      if (method === 'GET' && rest.length === 2) {
        const refs = [...repo.refs.keys()]
          .sort()
          .map((name) => ({ ref: name, node_id: globalId('G', `${owner}/${repoName}:${name}`), url: `/repos/${owner}/${repoName}/git/refs/${name}`, object: { sha: repo.refs.get(name)!, type: 'commit', url: `/repos/${owner}/${repoName}/git/commits/${repo.refs.get(name)!}` } }));
        return ok(200, refs);
      }
      if (method === 'GET') {
        const fullRef = `refs/${refPath}`;
        const oid = repo.refs.get(fullRef);
        if (oid === undefined) return err(404, 'Not Found');
        return ok(200, { ref: fullRef, node_id: globalId('G', `${owner}/${repoName}:${fullRef}`), url: `/repos/${owner}/${repoName}/git/refs/${fullRef}`, object: { sha: oid, type: 'commit', url: `/repos/${owner}/${repoName}/git/commits/${oid}` } });
      }
      if (method === 'POST' && rest.length === 2) {
        const data = getBody();
        const ref = str(data.ref);
        const sha = str(data.sha);
        if (ref === undefined || sha === undefined) return err(422, 'ref and sha are required');
        if (!isObjectId(sha) || !repo.objects.has(sha)) return err(422, 'sha does not exist');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        store.touch(repo);
        return ok(201, { ref, node_id: globalId('G', `${owner}/${repoName}:${ref}`), url: `/repos/${owner}/${repoName}/git/refs/${ref}`, object: { sha, type: 'commit', url: `/repos/${owner}/${repoName}/git/commits/${sha}` } });
      }
      if (method === 'PATCH' && rest.length > 2) {
        const fullRef = `refs/${refPath}`;
        const data = getBody();
        const sha = str(data.sha);
        if (sha === undefined) return err(422, 'sha is required');
        if (!repo.refs.has(fullRef)) return err(404, 'Not Found');
        if (!isObjectId(sha) || !repo.objects.has(sha)) return err(422, 'sha does not exist');
        repo.refs.set(fullRef, sha);
        store.touch(repo);
        return ok(200, { ref: fullRef, node_id: globalId('G', `${owner}/${repoName}:${fullRef}`), url: `/repos/${owner}/${repoName}/git/refs/${fullRef}`, object: { sha, type: 'commit', url: `/repos/${owner}/${repoName}/git/commits/${sha}` } });
      }
      if (method === 'DELETE' && rest.length > 2) {
        const fullRef = `refs/${refPath}`;
        if (!repo.refs.has(fullRef)) return err(404, 'Not Found');
        repo.refs.delete(fullRef);
        store.touch(repo);
        return ok(204, null);
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        return ok(200, [...repo.labels.values()].map((label) => ({ id: 0, node_id: globalId('L', `${owner}/${repoName}:${label.name}`), url: `/repos/${owner}/${repoName}/labels/${encodeURIComponent(label.name)}`, name: label.name, color: label.color, default: false, description: '' })));
      }
      if (method === 'POST') {
        const data = getBody();
        const name = str(data.name);
        if (name === undefined || name === '') return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'Label already exists');
        const color = str(data.color) ?? '000000';
        repo.labels.set(name, { name, color });
        return ok(201, { id: 0, node_id: globalId('L', `${owner}/${repoName}:${name}`), url: `/repos/${owner}/${repoName}/labels/${encodeURIComponent(name)}`, name, color, default: false, description: '' });
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/labels/{name}
    if (rest.length === 2 && rest[0] === 'labels' && method === 'GET') {
      const label = repo.labels.get(rest[1]!);
      if (label === undefined) return err(404, 'Not Found');
      return ok(200, { id: 0, node_id: globalId('L', `${owner}/${repoName}:${label.name}`), url: `/repos/${owner}/${repoName}/labels/${encodeURIComponent(label.name)}`, name: label.name, color: label.color, default: false, description: '' });
    }

    // /repos/{owner}/{repo}/issues
    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        return ok(200, issues.map((issue) => issueJson(store, repo, issue)));
      }
      if (method === 'POST') {
        const data = getBody();
        const title = str(data.title);
        if (title === undefined || title === '') return err(422, 'title is required');
        const labels = Array.isArray(data.labels) ? data.labels.filter((item): item is string => typeof item === 'string') : [];
        const result = store.createIssue(repo, title, str(data.body) ?? '', labels);
        if ('error' in result) return err(result.status, result.error);
        return ok(201, issueJson(store, repo, result.issue));
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/issues/{number}[/comments]
    if (rest.length >= 2 && rest[0] === 'issues') {
      const number = Number(rest[1]);
      const issue = repo.issues.find((item) => item.number === number);
      if (issue === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          const data = getBody();
          if (str(data.title) !== undefined) issue.title = str(data.title)!;
          if (str(data.body) !== undefined) issue.body = str(data.body)!;
          if (str(data.state) === 'closed' || str(data.state) === 'open') issue.state = str(data.state) as 'open' | 'closed';
          if (Array.isArray(data.labels)) {
            const labels = data.labels.filter((item): item is string => typeof item === 'string');
            for (const label of labels) if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
            issue.labels = labels;
          }
          return ok(200, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return ok(200, issue.comments.map((comment) => ({
            id: comment.id,
            node_id: globalId('C', `${owner}/${repoName}:${issue.number}:${comment.id}`),
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: isoFromEpochSec(store.trialNowSec),
            updated_at: isoFromEpochSec(store.trialNowSec),
            html_url: `https://github.com/${owner}/${repoName}/issues/${issue.number}#issuecomment-${comment.id}`,
            url: `/repos/${owner}/${repoName}/issues/comments/${comment.id}`,
          })));
        }
        if (method === 'POST') {
          const data = getBody();
          const commentBody = str(data.body);
          if (commentBody === undefined || commentBody === '') return err(422, 'body is required');
          const comment = { id: store.nextCommentId(), body: commentBody };
          issue.comments.push(comment);
          return ok(201, {
            id: comment.id,
            node_id: globalId('C', `${owner}/${repoName}:${issue.number}:${comment.id}`),
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: isoFromEpochSec(store.trialNowSec),
            updated_at: isoFromEpochSec(store.trialNowSec),
            html_url: `https://github.com/${owner}/${repoName}/issues/${issue.number}#issuecomment-${comment.id}`,
            url: `/repos/${owner}/${repoName}/issues/comments/${comment.id}`,
          });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/pulls
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        return ok(200, pulls.map((pull) => pullJson(store, repo, pull)));
      }
      if (method === 'POST') {
        const data = getBody();
        const title = str(data.title);
        const head = str(data.head);
        const base = str(data.base);
        if (title === undefined || title === '') return err(422, 'title is required');
        if (head === undefined || base === undefined) return err(422, 'head and base are required');
        const result = store.createPull(repo, title, str(data.body) ?? '', head, base);
        if ('error' in result) return err(result.status, result.error);
        return ok(201, pullJson(store, repo, result.pull));
      }
      return err(404, 'Not Found');
    }

    // /repos/{owner}/{repo}/pulls/{number}[/files|/merge]
    if (rest.length >= 2 && rest[0] === 'pulls') {
      const number = Number(rest[1]);
      const pull = repo.pulls.find((item) => item.number === number);
      if (pull === undefined) return err(404, 'Not Found');
      if (rest.length === 2 && method === 'GET') return ok(200, pullJson(store, repo, pull));
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const base = store.mergeBase(repo, pull.head.sha, pull.base.sha);
        const changes = base === '' ? [] : store.diffCommits(repo, base, pull.head.sha);
        return ok(200, changes.map((change) => ({
          sha: '',
          filename: change.filename,
          status: change.status === 'removed' ? 'removed' : change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
          patch: '',
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const result = store.mergePull(repo, pull);
        if ('error' in result) return err(result.status, result.error);
        return ok(200, { sha: result.sha, merged: true, message: `Pull Request successfully merged` });
      }
      if (rest.length === 2 && method === 'PATCH') {
        const data = getBody();
        if (str(data.title) !== undefined) pull.title = str(data.title)!;
        if (str(data.body) !== undefined) pull.body = str(data.body)!;
        if (str(data.state) === 'closed' && pull.state === 'open') pull.state = 'closed';
        return ok(200, pullJson(store, repo, pull));
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
