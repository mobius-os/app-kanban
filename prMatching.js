// GitHub pull request links: recognizing a PR URL, describing its live status,
// and matching the owner's open PRs to cards for `sync-open-prs`.

const PULL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/u

export function parsePullRequestUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    const match = url.hostname === 'github.com' && url.pathname.match(PULL_PATH)
    return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null
  } catch { return null }
}

// Status is informational and read with the owner's own GitHub connection, so
// it must degrade honestly: only a successful read describes the PR. Every other
// answer explains why this Möbius cannot see it in a neutral tone, so a missing
// connection or a private repository never looks like a closed pull request.
// The status reply already carries the pull request's title, so the card can
// name each pull request without a second request.
export function pullRequestStatus(httpStatus, pull) {
  if (httpStatus === 200) {
    const title = typeof pull?.title === 'string' ? pull.title.trim() : ''
    const named = status => (title ? { ...status, title } : status)
    if (pull?.merged_at) return named({ label: 'Merged', tone: 'merged' })
    if (pull?.draft) return named({ label: 'Draft', tone: 'draft' })
    if (pull?.state === 'open') return named({ label: 'Open', tone: 'open' })
    if (pull?.state === 'closed') return named({ label: 'Closed', tone: 'closed' })
  }
  if (httpStatus === 401) return { label: 'Connect GitHub', tone: 'unknown', hint: 'Connect GitHub in Möbius Settings to see pull request status.' }
  if (httpStatus === 404) return { label: 'Not visible', tone: 'unknown', hint: 'Your GitHub connection can’t see this pull request. It may be private or deleted.' }
  return { label: 'Unavailable', tone: 'unknown', hint: 'GitHub status couldn’t be loaded. Try refreshing later.' }
}

const IGNORED_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'this', 'that', 'to', 'use', 'using', 'with'])
const REPOSITORY_TITLE_SIMILARITY_MINIMUM = 0.2
const TITLE_SIMILARITY_MINIMUM = 0.3

// Plurals are the only word variation matched automatically. Anything looser
// belongs to the agent's judgment: it can link a PR explicitly with
// `update-card` or `complete-matching-card`.
const singular = word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)
const titleWords = value => new Set((String(value || '').toLocaleLowerCase().match(/[a-z0-9]+/g) || [])
  .filter(word => !IGNORED_WORDS.has(word)).map(singular))

const prTitleSimilarity = (left, right) => {
  const a = titleWords(left)
  const b = titleWords(right)
  const overlap = [...a].filter(word => b.has(word)).length
  return overlap ? overlap / new Set([...a, ...b]).size : 0
}
const coverage = (left, right) => {
  const a = titleWords(left), b = titleWords(right)
  const overlap = [...a].filter(word => b.has(word)).length
  return { overlap, score: overlap ? overlap / Math.min(a.size, b.size) : 0 }
}

const cardMatchText = card => [card?.title, ...(Array.isArray(card?.checklist) ? card.checklist.map(item => item?.text) : [])].filter(Boolean).join('\n')
const cardIntentText = card => [cardMatchText(card), String(card?.notes || '').replace(/^✅ Done —.*\n(?:PR|Link): https?:\/\/\S+$/gmu, '')].filter(Boolean).join('\n')

const pullRepositoryName = pull => {
  try { return new URL(pull?.repository_url || pull?.html_url || '').pathname.split('/').filter(Boolean).at(-1)?.replace(/^app-/u, '').toLocaleLowerCase() || '' } catch { return '' }
}

export const pullMatchesCard = (pull, card) => {
  const text = cardMatchText(card)
  const titleScore = prTitleSimilarity(pull?.title, text)
  const description = coverage(pull?.body, cardIntentText(card))
  const repository = pullRepositoryName(pull)
  const repositoryMatch = repository && text.toLocaleLowerCase().includes(repository)
  const exactTitleMatch = String(pull?.title || '').trim() === String(card?.title || '').trim()
  const titleEligible = exactTitleMatch || titleScore >= TITLE_SIMILARITY_MINIMUM || (repositoryMatch && titleScore >= REPOSITORY_TITLE_SIMILARITY_MINIMUM)
  const descriptionEligible = description.overlap >= 5 && description.score >= 0.5
  return titleEligible || descriptionEligible
}
