// Builds the "Last 7 days" block in README.md and README.zh-CN.md:
// a small stats panel (SVG) plus a list of the repos I worked on.
// Counts commits on each repo's default branch and PRs I opened.
// Needs ACTIVITY_TOKEN, a token that can read the private repos too.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DAYS = Number(process.env.WINDOW_DAYS || 7);
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 6);
const CONFIG_PATH = ".github/recent-activity.json";
const ASSET_DIR = "assets/activity";
const START = "<!-- RECENT_ACTIVITY:START -->";
const END = "<!-- RECENT_ACTIVITY:END -->";

const TEXT = {
  en: {
    readme: "README.md",
    heading: "Recent Activity",
    title: `Last ${DAYS} days`,
    rows: ["Active repos", "Commits", "Pull requests", "Lines changed", "Net"],
    commits: (n) => `${n} ${n === 1 ? "commit" : "commits"}`,
    prs: (n) => `${n} ${n === 1 ? "PR" : "PRs"}`,
    privateName: "Private repo",
    privateDesc: "Private repository.",
    otherPrivate: (n) => `${n} other private ${n === 1 ? "repo" : "repos"}`,
    alt: `Commits, pull requests and lines changed in the last ${DAYS} days`,
    empty: `No commits or PRs in the last ${DAYS} days.`,
    note: (date) =>
      `Commits on each repo's default branch and PRs I opened, private repos included. Updated daily by a GitHub Actions workflow, last run ${date}.`,
  },
  zh: {
    readme: "README.zh-CN.md",
    heading: "最近动态",
    title: `最近 ${DAYS} 天`,
    rows: ["活跃仓库", "提交", "PR", "增删行数", "净增"],
    commits: (n) => `${n} 次提交`,
    prs: (n) => `${n} 个 PR`,
    privateName: "私有仓库",
    privateDesc: "私有仓库。",
    otherPrivate: (n) => `另外 ${n} 个私有仓库`,
    alt: `最近 ${DAYS} 天的提交、PR 和代码增删`,
    empty: `最近 ${DAYS} 天没有提交或 PR。`,
    note: (date) =>
      `统计各仓库默认分支上的提交和我开的 PR，包括私有仓库。由 GitHub Actions 每天更新，上次更新 ${date}。`,
  },
};

const THEMES = {
  light: { bg: "#ffffff", border: "#d0d7de", title: "#1f2328", label: "#656d76", value: "#1f2328", line: "#eaeef2", add: "#1a7f37", del: "#cf222e" },
  dark: { bg: "#0d1117", border: "#30363d", title: "#e6edf3", label: "#8b949e", value: "#e6edf3", line: "#21262d", add: "#3fb950", del: "#f85149" },
};

async function main() {
  const token = process.env.ACTIVITY_TOKEN;
  if (!token) {
    console.log("::warning::ACTIVITY_TOKEN is not set, skipping. Add it under Settings > Secrets and variables > Actions.");
    return;
  }

  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const gql = (query, variables) => graphql(token, query, variables);
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000);

  const viewer = (await gql("query { viewer { id login } }")).viewer;
  const exclude = new Set((config.exclude || []).map((name) => name.toLowerCase()));
  // "as" in the config counts a repo under another one, e.g. the private
  // team repo under the public SecureView repo.
  const aliases = Object.fromEntries(
    Object.entries(config.repos || {})
      .filter(([, label]) => label.as)
      .map(([name, label]) => [name.toLowerCase(), label.as]),
  );
  const repos = new Map();
  const entry = (repo) => {
    const target = aliases[repo.nameWithOwner.toLowerCase()];
    if (target) repo = { nameWithOwner: target, url: `https://github.com/${target}`, description: null, isPrivate: false };
    const key = repo.nameWithOwner.toLowerCase();
    const existing = repos.get(key);
    if (!existing) repos.set(key, { ...repo, commits: 0, additions: 0, deletions: 0, prs: 0 });
    else if (!existing.description && repo.description) existing.description = repo.description;
    return repos.get(key);
  };

  for (const repo of await recentRepos(gql, since)) {
    if (exclude.has(repo.nameWithOwner.toLowerCase())) continue;
    const stats = await commitStats(gql, repo.nameWithOwner, since, viewer.id);
    if (stats.commits === 0) continue;
    const item = entry(repo);
    item.commits += stats.commits;
    item.additions += stats.additions;
    item.deletions += stats.deletions;
  }

  for (const repo of await openedPullRequests(gql, viewer.login, since)) {
    if (exclude.has(repo.nameWithOwner.toLowerCase())) continue;
    entry(repo).prs += 1;
  }

  const activity = [...repos.values()].sort(
    (a, b) => b.commits - a.commits || b.prs - a.prs || a.nameWithOwner.localeCompare(b.nameWithOwner),
  );
  const date = new Date().toISOString().slice(0, 10);

  await mkdir(ASSET_DIR, { recursive: true });
  for (const [lang, text] of Object.entries(TEXT)) {
    for (const theme of Object.keys(THEMES)) {
      await writeFile(`${ASSET_DIR}/activity-${lang}-${theme}.svg`, renderPanel(activity, text, THEMES[theme]));
    }
    const readme = await readFile(text.readme, "utf8");
    const block = renderBlock(activity, lang, text, config, viewer.login, date);
    await writeFile(text.readme, replaceBlock(readme, block));
  }

  console.log(`${activity.length} repos with activity in the last ${DAYS} days.`);
}

async function graphql(token, query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "recent-activity" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GitHub GraphQL failed (${res.status}): ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

// Repos I own or can push to, newest push first. Stops at the first one
// that has not been pushed to since the start of the window.
async function recentRepos(gql, since) {
  const repos = [];
  let cursor = null;
  for (;;) {
    const data = await gql(
      `query($cursor: String) {
        viewer {
          repositories(
            first: 50
            after: $cursor
            affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
            ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
            orderBy: { field: PUSHED_AT, direction: DESC }
          ) {
            nodes { nameWithOwner url description isPrivate pushedAt }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { cursor },
    );
    const page = data.viewer.repositories;
    for (const repo of page.nodes) {
      if (!repo.pushedAt || new Date(repo.pushedAt) < since) return repos;
      repos.push(repo);
    }
    if (!page.pageInfo.hasNextPage) return repos;
    cursor = page.pageInfo.endCursor;
  }
}

// My commits on the default branch since the start of the window.
// Merge commits are skipped so their lines are not counted twice.
async function commitStats(gql, nameWithOwner, since, authorId) {
  const [owner, name] = nameWithOwner.split("/");
  const stats = { commits: 0, additions: 0, deletions: 0 };
  let cursor = null;
  for (;;) {
    const data = await gql(
      `query($owner: String!, $name: String!, $since: GitTimestamp!, $author: ID!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: 100, after: $cursor, since: $since, author: { id: $author }) {
                  nodes { additions deletions parents(first: 2) { totalCount } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        }
      }`,
      { owner, name, since: since.toISOString(), author: authorId, cursor },
    );
    const history = data.repository?.defaultBranchRef?.target?.history;
    if (!history) return stats;
    for (const commit of history.nodes) {
      if (commit.parents.totalCount > 1) continue;
      stats.commits += 1;
      stats.additions += commit.additions;
      stats.deletions += commit.deletions;
    }
    if (!history.pageInfo.hasNextPage) return stats;
    cursor = history.pageInfo.endCursor;
  }
}

// One entry per PR I opened in the window, in any repo the token can see.
async function openedPullRequests(gql, login, since) {
  const repos = [];
  const query = `author:${login} is:pr created:>=${since.toISOString().slice(0, 10)}`;
  let cursor = null;
  for (;;) {
    const data = await gql(
      `query($query: String!, $cursor: String) {
        search(query: $query, type: ISSUE, first: 100, after: $cursor) {
          nodes { ... on PullRequest { repository { nameWithOwner url description isPrivate } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { query, cursor },
    );
    for (const node of data.search.nodes) {
      if (node.repository) repos.push(node.repository);
    }
    if (!data.search.pageInfo.hasNextPage) return repos;
    cursor = data.search.pageInfo.endCursor;
  }
}

const formatNumber = (n) => n.toLocaleString("en-US");
const signed = (n) => (n < 0 ? `−${formatNumber(-n)}` : `+${formatNumber(n)}`);

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`);
}

export function renderPanel(activity, text, theme) {
  const totals = activity.reduce(
    (sum, repo) => ({
      commits: sum.commits + repo.commits,
      prs: sum.prs + repo.prs,
      additions: sum.additions + repo.additions,
      deletions: sum.deletions + repo.deletions,
    }),
    { commits: 0, prs: 0, additions: 0, deletions: 0 },
  );
  const net = totals.additions - totals.deletions;
  const values = [
    [{ text: formatNumber(activity.length) }],
    [{ text: formatNumber(totals.commits) }],
    [{ text: formatNumber(totals.prs) }],
    [
      { text: `+${formatNumber(totals.additions)}`, color: theme.add },
      { text: " / " },
      { text: `−${formatNumber(totals.deletions)}`, color: theme.del },
    ],
    [{ text: signed(net) }],
  ];

  const width = 480;
  const rowHeight = 30;
  const top = 72;
  const height = top + rowHeight * (values.length - 1) + 20;
  const font = `ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace`;

  const rows = values
    .map((parts, i) => {
      const y = top + i * rowHeight;
      const spans = parts
        .map((part) => `<tspan${part.color ? ` fill="${part.color}"` : ""}>${escapeXml(part.text)}</tspan>`)
        .join("");
      return [
        `<line x1="24" y1="${y - 20}" x2="${width - 24}" y2="${y - 20}" stroke="${theme.line}" />`,
        `<text x="24" y="${y}" fill="${theme.label}" font-size="14">${escapeXml(text.rows[i])}</text>`,
        `<text x="${width - 24}" y="${y}" fill="${theme.value}" font-size="14" font-weight="600" text-anchor="end">${spans}</text>`,
      ].join("\n  ");
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(text.alt)}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="${theme.bg}" stroke="${theme.border}" />
  <g font-family='${font}'>
  <text x="24" y="32" fill="${theme.title}" font-size="16" font-weight="600">${escapeXml(text.title)}</text>
  ${rows}
  </g>
</svg>
`;
}

export function renderBlock(activity, lang, text, config, login, date) {
  const labels = Object.fromEntries(Object.entries(config.repos || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const items = [];
  let hiddenPrivate = 0;

  for (const repo of activity) {
    const label = labels[repo.nameWithOwner.toLowerCase()];
    if (repo.isPrivate && !label) {
      hiddenPrivate += 1;
      continue;
    }
    const [owner, short] = repo.nameWithOwner.split("/");
    const name = label?.name || (owner.toLowerCase() === login.toLowerCase() ? short : repo.nameWithOwner);
    const url = label?.url || (repo.isPrivate ? null : repo.url);
    const description = label?.[lang] || label?.en || repo.description || "";
    items.push({ name, url, description, commits: repo.commits, prs: repo.prs });
  }

  const shown = items.slice(0, MAX_ITEMS);
  const lines = shown.map((item) => {
    const title = item.url ? `**[${escapeMarkdown(item.name)}](${item.url})**` : `**${escapeMarkdown(item.name)}**`;
    const description = item.description ? ` · ${escapeMarkdown(item.description.trim())}` : "";
    return `- ${title}${description} <sub>${counts(item, text)}</sub>`;
  });
  if (hiddenPrivate > 0) lines.push(`- ${text.otherPrivate(hiddenPrivate)}`);

  const panel = [
    `<picture>`,
    `  <source media="(prefers-color-scheme: dark)" srcset="./${ASSET_DIR}/activity-${lang}-dark.svg" />`,
    `  <img src="./${ASSET_DIR}/activity-${lang}-light.svg" width="480" alt="${escapeXml(text.alt)}" />`,
    `</picture>`,
  ].join("\n");

  return [`### ${text.heading}`, "", panel, "", lines.length ? lines.join("\n") : text.empty, "", `<sub>${text.note(date)}</sub>`].join("\n");
}

function counts(item, text) {
  const parts = [];
  if (item.commits) parts.push(text.commits(item.commits));
  if (item.prs) parts.push(text.prs(item.prs));
  return parts.join(" · ");
}

export function replaceBlock(readme, block) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README is missing the ${START} / ${END} markers.`);
  }
  return `${readme.slice(0, start + START.length)}\n${block}\n${readme.slice(end)}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
