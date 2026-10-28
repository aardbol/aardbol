// Renders the "Upstream contributions" card: merged pull requests you authored
// in repositories you do not control, ranked by the project's stars.
//
// Usage: GITHUB_TOKEN=... GITHUB_LOGIN=your-login node scripts/upstream-contributions.mjs

import { writeFile } from "node:fs/promises"

const TOKEN = process.env.GITHUB_TOKEN
const LOGIN = process.env.GITHUB_LOGIN
const LIMIT = Number(process.env.UPSTREAM_LIMIT ?? 12)
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

/** Collect merged pull requests authored by the user */
async function collect() {
  const query = `
    query ($login: String!, $after: String) {
      user(login: $login) {
        pullRequests(first: 100, after: $after, states: MERGED) {
          pageInfo { hasNextPage endCursor }
          nodes {
            repository {
              nameWithOwner
              stargazerCount
              viewerPermission
              owner { login }
            }
          }
        }
      }
    }`

  const projects = new Map()
  let after = null
  let merged = 0

  do {
    const {user} = await graphql(query, {login: LOGIN, after})
    const {nodes, pageInfo} = user.pullRequests
    for (const {repository} of nodes) {
      // Own account or repositories you administer are not "upstream"
      if (!repository)
        continue
      if (!INCLUDE_OWN && (repository.owner.login === LOGIN || repository.viewerPermission === "ADMIN"))
        continue
      merged++
      const {nameWithOwner, stargazerCount} = repository
      const current = projects.get(nameWithOwner) ?? {repo: nameWithOwner, stars: stargazerCount, prs: 0}
      current.prs++
      current.stars = stargazerCount
      projects.set(nameWithOwner, current)
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null
  } while (after)

  return {merged, projects: [...projects.values()]}
}

/** Compact star count, e.g. 1321 -> "1.3k" */
function stars(n) {
  if (n < 1000)
    return `${n}`
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, char => ({"<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"}[char]))
}

/** Render one colour scheme */
function render({merged, total, projects, theme}) {
  const color = theme === "dark"
    ? {fg: "#c9d1d9", muted: "#8b949e", accent: "#58a6ff", rule: "#30363d"}
    : {fg: "#24292f", muted: "#57606a", accent: "#0969da", rule: "#d0d7de"}

  const rowHeight = 26
  const top = 92
  const height = top + projects.length * rowHeight + 8
  const font = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`
  const mono = `SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace`

  const rows = projects.map(({repo, stars: count, prs}, index) => {
    const y = top + index * rowHeight + 17
    return `
    <text x="0" y="${y}" font-family="${mono}" font-size="12.5" fill="${color.fg}">${escapeXml(repo)}</text>
    <text x="800" y="${y}" text-anchor="end" font-size="12.5" fill="${color.muted}">${stars(count)}</text>
    <text x="952" y="${y}" text-anchor="end" font-size="12.5" fill="${color.accent}" font-weight="600">${prs}</text>
    <line x1="0" y1="${y + 9}" x2="952" y2="${y + 9}" stroke="${color.rule}" stroke-width="1" opacity="0.6"/>`
  }).join("")

  // Column labels
  const labels = `
    <text x="0" y="72" font-size="10" letter-spacing="1" fill="${color.muted}">PROJECT</text>
    <text x="800" y="72" text-anchor="end" font-size="10" letter-spacing="1" fill="${color.muted}">STARS</text>
    <text x="952" y="72" text-anchor="end" font-size="10" letter-spacing="1" fill="${color.muted}">MERGED PRS</text>
    <line x1="0" y1="80" x2="952" y2="80" stroke="${color.rule}" stroke-width="1"/>`

  const subtitle = projects.length
    ? `${merged} merged pull requests across ${total} project${total === 1 ? "" : "s"}`
    : "No merged pull requests outside your own repositories yet"

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" role="img" aria-labelledby="title desc" font-family="${font}">
  <title id="title">Upstream contributions</title>
  <desc id="desc">${escapeXml(subtitle)}</desc>
  <text x="0" y="22" font-family="${font}" font-size="16" font-weight="600" fill="${color.fg}">Upstream contributions</text>
  <text x="0" y="44" font-family="${font}" font-size="12" fill="${color.muted}">${escapeXml(subtitle)}</text>
  <g font-family="${font}">${labels}</g>${rows}
</svg>`
}

const data = await collect()
const ranked = {merged: data.merged, total: data.projects.length, projects: data.projects.sort((a, b) => b.stars - a.stars || b.prs - a.prs).slice(0, LIMIT)}

for (const theme of ["light", "dark"])
  await writeFile(FILES[theme], render({...ranked, theme}))

console.log(`upstream: ${ranked.merged} merged PRs across ${data.projects.length} projects, card shows ${ranked.projects.length}`)