const IGNORED_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'this', 'that', 'to', 'use', 'using', 'with'])
const TITLE_ALIASES = { handles: ['handle', 'name'], handle: ['name'], verified: ['name'], collaborators: ['collaborator', 'user'], collaborator: ['user'], users: ['user'], assignee: ['assign'], assign: ['assignee'], attachments: ['attachment'], previews: ['preview'], entries: ['entry'] }
const REPOSITORY_TITLE_SIMILARITY_MINIMUM = 0.2

const titleWords = value => new Set((String(value || '').toLocaleLowerCase().match(/[a-z0-9]+/g) || [])
  .filter(word => !IGNORED_WORDS.has(word)).flatMap(word => [word, ...(TITLE_ALIASES[word] || [])]))

export const prTitleSimilarity = (left, right) => {
  const a = titleWords(left)
  const b = titleWords(right)
  const overlap = [...a].filter(word => b.has(word)).length
  return overlap ? overlap / new Set([...a, ...b]).size : 0
}

export const cardMatchText = card => [card?.title, ...(Array.isArray(card?.checklist) ? card.checklist.map(item => item?.text) : [])].filter(Boolean).join('\n')

export const pullRepositoryName = pull => {
  try { return new URL(pull?.repository_url || pull?.html_url || '').pathname.split('/').filter(Boolean).at(-1)?.replace(/^app-/u, '').toLocaleLowerCase() || '' } catch { return '' }
}

export const pullCardScore = (pull, card) => {
  const text = cardMatchText(card)
  const titleScore = prTitleSimilarity(pull?.title, text)
  const repository = pullRepositoryName(pull)
  const repositoryMatch = repository && text.toLocaleLowerCase().includes(repository)
  const exactTitleMatch = String(pull?.title || '').trim() === String(card?.title || '').trim()
  return {
    score: titleScore + (repositoryMatch ? 1 : 0),
    eligible: exactTitleMatch || (repositoryMatch && titleScore >= REPOSITORY_TITLE_SIMILARITY_MINIMUM),
  }
}
