/**
 * Every React Query cache key, in one place.
 *
 * Collected rather than written inline so invalidation is reliable: a stringly-typed
 * key duplicated across a component and a mutation is the usual way a list silently
 * stops refreshing after a delete. Hierarchical prefixes mean invalidating
 * `keys.files.all` catches every paginated page at once.
 */
export const keys = {
  appConfig: ['app-config'],

  auth: {
    session: ['auth', 'session']
  },

  emailConfig: ['email-config'],
  inboxPatterns: ['inbox-patterns'],

  files: {
    all: ['files'],
    list: (params) => ['files', 'list', params],
    stats: ['files', 'stats']
  },

  campaign: {
    status: (sessionId) => ['campaign', 'status', sessionId]
  },

  lane: {
    view: (campaignId) => ['lane', campaignId]
  },

  imap: {
    all: ['imap'],
    credentials: ['imap', 'credentials'],
    accounts: ['imap', 'accounts'],
    testResults: (params) => ['imap', 'test-results', params]
  },

  health: ['system-health']
};
