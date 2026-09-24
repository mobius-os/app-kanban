const IGNORED_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'this', 'that', 'to', 'use', 'using', 'with'])
const TITLE_ALIASES = {
  handles: ['handle', 'name'], handle: ['name'], verified: ['name'], collaborators: ['collaborator', 'user'], collaborator: ['user'], users: ['user'], assignee: ['assign'], assign: ['assignee'], attachments: ['attachment'], previews: ['preview'], entries: ['entry'],
  model: ['models'], models: ['model'],
  goal: ['goals'], goals: ['goal'], polish: ['fix', 'improve'],
  robustness: ['robust', 'reliability'], robust: ['robustness'],
  error: ['errors', 'recover', 'busy', 'capacity'], errors: ['error', 'recover', 'busy', 'capacity'],
  recover: ['recovery', 'retry'], recovery: ['recover', 'retry'],
  busy: ['capacity'], capacity: ['busy'],
  backoff: ['delayed', 'retry'], delayed: ['backoff', 'retry'], retry: ['backoff', 'recover'],
  graciously: ['recover'],
}
const REPOSITORY_TITLE_SIMILARITY_MINIMUM = 0.2
const TITLE_SIMILARITY_MINIMUM = 0.3

const titleWords = value => new Set((String(value || '').toLocaleLowerCase().match(/[a-z0-9]+/g) || [])
  .filter(word => !IGNORED_WORDS.has(word)).flatMap(word => [word, ...(TITLE_ALIASES[word] || [])]))

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
const cardIntentText = card => [cardMatchText(card), String(card?.notes || '').replace(/^✅ Done —.*\nPR: https?:\/\/\S+$/gmu, '')].filter(Boolean).join('\n')

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
