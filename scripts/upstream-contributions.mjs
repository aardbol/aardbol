// Renders the "Upstream contributions" card: commits and merged pull requests
// you authored in projects you do not control, in a two-column grid ranked by
// the project's stars.
//
// Usage: GITHUB_TOKEN=... GITHUB_LOGIN=your-login node scripts/upstream-contributions.mjs

import { writeFile } from "node:fs/promises"

const TOKEN = process.env.GITHUB_TOKEN
const LOGIN = process.env.GITHUB_LOGIN
const LIMIT = Number(process.env.UPSTREAM_LIMIT ?? 16)
// Set UPSTREAM_INCLUDE_OWN=1 to also count repositories you administer yourself
const INCLUDE_OWN = process.env.UPSTREAM_INCLUDE_OWN === "1"
const FILES = { light: "upstream-contributions.svg", dark: "upstream-contributions-dark.svg" }

if (!TOKEN || !LOGIN)
  throw new Error("GITHUB_TOKEN and GITHUB_LOGIN are required")

/** Minimal GraphQL client */
async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "authorization": `bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": "profile-cards",
    },
    body: JSON.stringify({ query, variables }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new Error(`GraphQL HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`)
  if (payload.errors?.length)
    throw new Error(`GraphQL: ${payload.errors.map(({message}) => message).join("; ")}`)
  return payload.data
}

/** Commit contributions for one calendar year, grouped by repository */
async function year(from, to) {
  const {user} = await graphql(
    `query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            contributions(first: 1) { totalCount }
            repository {
              nameWithOwner
              stargazerCount
              viewerPermission
              owner { login avatarUrl }
            }
          }
        }
      }
    }`,
    {login: LOGIN, from, to},
  )
  return user.contributionsCollection.commitContributionsByRepository
}

/** Every merged pull request authored by the user */
async function pulls() {
  const query = `query ($login: String!, $after: String) {
    user(login: $login) {
      pullRequests(first: 100, after: $after, states: MERGED) {
        pageInfo { hasNextPage endCursor }
        nodes {
          createdAt
          repository {
            nameWithOwner
            stargazerCount
            viewerPermission
            owner { login avatarUrl }
          }
        }
      }
    }
  }`

  const nodes = []
  let after = null
  do {
    const {user} = await graphql(query, {login: LOGIN, after})
    nodes.push(...user.pullRequests.nodes)
    after = user.pullRequests.pageInfo.hasNextPage ? user.pullRequests.pageInfo.endCursor : null
  } while (after)
  return nodes
}

/** True when a repository does not belong to the user or an org they administer */
function upstream(repository) {
  if (!repository)
    return false
  return INCLUDE_OWN || (repository.owner.login !== LOGIN && repository.viewerPermission !== "ADMIN")
}

/** Walk every year since the account was created and merge commits with merged pull requests */
async function collect() {
  const {user} = await graphql(`query ($login: String!) { user(login: $login) { createdAt } }`, {login: LOGIN})
  const firstYear = Number(process.env.UPSTREAM_SINCE ?? new Date(user.createdAt).getUTCFullYear())
  const currentYear = new Date().getUTCFullYear()

  const projects = new Map()
  const entry = repository => {
    if (!projects.has(repository.nameWithOwner)) {
      projects.set(repository.nameWithOwner, {
        repo: repository.nameWithOwner,
        stars: repository.stargazerCount,
        avatar: repository.owner.avatarUrl,
        commits: 0,
        prs: 0,
        first: Infinity,
        last: -Infinity,
      })
    }
    const project = projects.get(repository.nameWithOwner)
    project.stars = repository.stargazerCount
    return project
  }

  for (let current = firstYear; current <= currentYear; current++) {
    const from = `${current}-01-01T00:00:00Z`
    const to = current === currentYear ? new Date().toISOString() : `${current}-12-31T23:59:59Z`
    for (const {contributions: {totalCount}, repository} of await year(from, to)) {
      if (!upstream(repository))
        continue
      const project = entry(repository)
      project.commits += totalCount
      project.first = Math.min(project.first, current)
      project.last = Math.max(project.last, current)
    }
  }

  for (const {createdAt, repository} of await pulls()) {
    if (!upstream(repository))
      continue
    const project = entry(repository)
    const contributorYear = new Date(createdAt).getUTCFullYear()
    project.prs++
    project.first = Math.min(project.first, contributorYear)
    project.last = Math.max(project.last, contributorYear)
  }

  const all = [...projects.values()].filter(({commits, prs}) => commits + prs > 0)
  return {
    commits: all.reduce((sum, {commits}) => sum + commits, 0),
    prs: all.reduce((sum, {prs}) => sum + prs, 0),
    projects: all,
  }
}

/** Downscale the owner avatar and inline it, so the card stays self-contained */
async function avatar(url) {
  const source = new URL(url)
  source.searchParams.set("s", "56")
  const response = await fetch(source)
  if (!response.ok)
    return ""
  const type = (response.headers.get("content-type") ?? "image/png").split(";")[0]
  const buffer = Buffer.from(await response.arrayBuffer())
  return `data:${type};base64,${buffer.toString("base64")}`
}

/** Compact star count, e.g. 1321 -> "1.3k" */
function stars(n) {
  if (n < 1000)
    return `${n}`
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

/** Rough rendered width of short labels, good enough for icon placement */
function width(text, size = 12) {
  return [...text].reduce((sum, char) => sum + (/[0-9]/.test(char) ? 0.6 : 0.5) * size, 0)
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, char => ({"<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"}[char]))
}

const THEMES = {
  light: {card: "#ffffff", row: "#f6f8fa", line: "#d0d7de", fg: "#1f2328", muted: "#59636e", star: "#9a6700", accent: "#8250df"},
  dark: {card: "#0d1117", row: "#161b22", line: "#30363d", fg: "#e6edf3", muted: "#9198a1", star: "#e3b341", accent: "#a371f7"},
}

const STAR_PATH = "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"
const COMMIT_PATH = "M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"
const PULL_PATH = "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"
const BRANCH_PATH = "M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"

/** Stat pair: icon + label, laid out left to right from a cursor */
function stat(x, y, {path, color, label, text}) {
  return `<svg x="${x}" y="${y}" width="12" height="12" viewBox="0 0 16 16"><path fill="${color}" d="${path}"/></svg>` +
    `<text x="${x + 16}" y="${y + 10}" font-size="12" fill="${text}">${label}</text>`
}

/** Render one colour scheme */
function render({commits, prs, total, projects, theme}) {
  const color = THEMES[theme]
  const font = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`
  const mono = `ui-monospace,SFMono-Regular,Menlo,monospace`

  const columns = 2
  const rowWidth = 390
  const rowHeight = 52
  const gapX = 12
  const gapY = 8
  const top = 72
  const rows = Math.ceil(projects.length / columns)
  const height = rows ? top + rows * (rowHeight + gapY) - gapY + 24 : top + 52

  const cards = projects.map((project, index) => {
    const column = index % columns
    const line = Math.floor(index / columns)
    const x = 24 + column * (rowWidth + gapX)
    const y = top + line * (rowHeight + gapY)
    const [owner, name] = project.repo.split("/")
    const years = project.first === project.last ? `${project.first}` : `${project.first}–${project.last}`
    const image = project.avatar

    // Stats line: stars, merged PRs, commits, in that order
    const stats = [{path: STAR_PATH, color: color.star, label: stars(project.stars), text: color.muted}]
    if (project.prs)
      stats.push({path: PULL_PATH, color: color.accent, label: plural(project.prs, "PR"), text: color.muted})
    if (project.commits)
      stats.push({path: COMMIT_PATH, color: color.muted, label: plural(project.commits, "commit"), text: color.muted})

    let offset = x + 48
    const statsMarkup = stats.map(stat_ => {
      const markup = stat(offset, y + 28, stat_)
      offset += 16 + width(stat_.label) + 12
      return markup
    }).join("")

    return `
    <g>
      <rect x="${x}" y="${y}" width="${rowWidth}" height="${rowHeight}" rx="8" fill="${color.row}" stroke="${color.line}"/>
      ${image ? `<image x="${x + 10}" y="${y + 12}" width="28" height="28" href="${image}" clip-path="url(#avatar)" preserveAspectRatio="xMidYMid slice"/>` : ""}
      <circle cx="${x + 24}" cy="${y + 26}" r="13.5" fill="none" stroke="${color.line}"/>
      <text x="${x + 48}" y="${y + 20}" font-size="13" fill="${color.muted}">${escapeXml(owner)}/<tspan font-weight="600" fill="${color.fg}">${escapeXml(name)}</tspan></text>
      <text x="${x + 378}" y="${y + 20}" text-anchor="end" font-size="11" font-family="${mono}" fill="${color.muted}">${years}</text>
      ${statsMarkup}
    </g>`
  }).join("")

  const summary = projects.length
    ? `${plural(prs, "merged PR")} and ${plural(commits, "commit")} across ${plural(total, "project")}`
    : "No contributions outside your own repositories yet"

  return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="${height}" viewBox="0 0 840 ${height}" fill="none" role="img" aria-labelledby="title desc" font-family="${font}">
  <title id="title">Upstream contributions</title>
  <desc id="desc">${escapeXml(summary)}</desc>
  <defs><clipPath id="avatar" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath></defs>
  <rect x="0.5" y="0.5" width="839" height="${height - 1}" rx="12" fill="${color.card}" stroke="${color.line}"/>
  <svg x="24" y="20" width="16" height="16" viewBox="0 0 16 16"><path fill="${color.accent}" d="${BRANCH_PATH}"/></svg>
  <text x="48" y="34" font-size="15" font-weight="600" fill="${color.fg}">Upstream contributions</text>
  <text x="816" y="34" text-anchor="end" font-size="12" fill="${color.muted}">${escapeXml(summary)}</text>${cards}
</svg>`
}

const data = await collect()
const ranked = {
  commits: data.commits,
  prs: data.prs,
  total: data.projects.length,
  projects: data.projects.sort((a, b) => b.stars - a.stars || b.commits - a.commits).slice(0, LIMIT),
}

await Promise.all(ranked.projects.map(async project => {
  project.avatar = await avatar(project.avatar)
}))

for (const theme of ["light", "dark"])
  await writeFile(FILES[theme], render({...ranked, theme}))

console.log(`upstream: ${data.prs} merged PRs and ${data.commits} commits across ${data.projects.length} projects, card shows ${ranked.projects.length}`)