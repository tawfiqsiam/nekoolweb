// @flow

const _ = require(`lodash`)
const Queue = require(`better-queue`)
const convertHrtime = require(`convert-hrtime`)
const { store, emitter } = require(`../redux`)
const { boundActionCreators } = require(`../redux/actions`)
const queryQueue = require(`./queue`)
const GraphQLRunner = require(`./graphql-runner`)

const seenIdsWithoutDataDependencies = new Set()
let queuedDirtyActions = []
const extractedQueryIds = new Set()

// Remove pages from seenIdsWithoutDataDependencies when they're deleted
// so their query will be run again if they're created again.
emitter.on(`DELETE_PAGE`, action => {
  seenIdsWithoutDataDependencies.delete(action.payload.path)
})

emitter.on(`CREATE_NODE`, action => {
  queuedDirtyActions.push(action)
})

emitter.on(`DELETE_NODE`, action => {
  queuedDirtyActions.push({ payload: action.payload })
})

/////////////////////////////////////////////////////////////////////
// Calculate dirty static/page queries

const popExtractedQueries = () => {
  const queries = [...extractedQueryIds]
  extractedQueryIds.clear()
  return queries
}

const findIdsWithoutDataDependencies = state => {
  const allTrackedIds = new Set()
  const boundAddToTrackedIds = allTrackedIds.add.bind(allTrackedIds)
  state.componentDataDependencies.nodes.forEach(dependenciesOnNode => {
    dependenciesOnNode.forEach(boundAddToTrackedIds)
  })
  state.componentDataDependencies.connections.forEach(
    dependenciesOnConnection => {
      dependenciesOnConnection.forEach(boundAddToTrackedIds)
    }
  )

  // Get list of paths not already tracked and run the queries for these
  // paths.
  const notTrackedIds = new Set(
    [
      ...Array.from(state.pages.values(), p => p.path),
      ...[...state.staticQueryComponents.values()].map(c => c.id),
    ].filter(
      x => !allTrackedIds.has(x) && !seenIdsWithoutDataDependencies.has(x)
    )
  )

  // Add new IDs to our seen array so we don't keep trying to run queries for them.
  // Pages without queries can't be tracked.
  for (const notTrackedId of notTrackedIds) {
    seenIdsWithoutDataDependencies.add(notTrackedId)
  }

  return notTrackedIds
}

const popNodeQueries = state => {
  const actions = _.uniq(queuedDirtyActions, a => a.payload.id)
  const uniqDirties = actions.reduce((dirtyIds, action) => {
    const node = action.payload

    if (!node || !node.id || !node.internal.type) return dirtyIds

    // Find components that depend on this node so are now dirty.
    if (state.componentDataDependencies.nodes.has(node.id)) {
      state.componentDataDependencies.nodes
        .get(node.id)
        .forEach(n => dirtyIds.add(n))
    }

    // Find connections that depend on this node so are now invalid.
    if (state.componentDataDependencies.connections.has(node.internal.type)) {
      state.componentDataDependencies.connections
        .get(node.internal.type)
        .forEach(n => {
          if (n) {
            dirtyIds.add(n)
          }
        })
    }

    return dirtyIds
  }, new Set())
  queuedDirtyActions = []
  return uniqDirties
}

const popNodeAndDepQueries = state => {
  const nodeQueries = popNodeQueries(state)

  const noDepQueries = findIdsWithoutDataDependencies(state)

  return _.uniq([...nodeQueries, ...noDepQueries])
}

/**
 * Calculates the set of dirty query IDs (page.paths, or
 * staticQuery.hash's). These are queries that:
 *
 * - depend on nodes or node collections (via
 *   `actions.createPageDependency`) that have changed.
 * - do NOT have node dependencies. Since all queries should return
 *   data, then this implies that node dependencies have not been
 *   tracked, and therefore these queries haven't been run before
 * - have been recently extracted (see `./query-watcher.js`)
 *
 * Note, this function pops queries off internal queues, so it's up
 * to the caller to reference the results
 */

const calcDirtyQueryIds = state =>
  _.union(popNodeAndDepQueries(state), popExtractedQueries())

/**
 * Same as `calcDirtyQueryIds`, except that we only include extracted
 * queries that depend on nodes or haven't been run yet. We do this
 * because the page component reducer/machine always enqueues
 * extractedQueryIds but during bootstrap we may not want to run those
 * page queries if their data hasn't changed since the last time we
 * ran Gatsby.
 */
const calcInitialDirtyQueryIds = state => {
  const nodeAndNoDepQueries = popNodeAndDepQueries(state)

  const extractedQueriesThatNeedRunning = _.intersection(
    popExtractedQueries(),
    nodeAndNoDepQueries
  )
  return _.union(extractedQueriesThatNeedRunning, nodeAndNoDepQueries)
}

/**
 * groups queryIds by whether they are static or page queries.
 */
const groupQueryIds = queryIds => {
  const grouped = _.groupBy(queryIds, p =>
    p.slice(0, 4) === `sq--` ? `static` : `page`
  )
  return {
    staticQueryIds: grouped.static || [],
    pageQueryIds: grouped.page || [],
  }
}

const reportStats = (queue, activity) => {
  const startQueries = process.hrtime()
  queue.on(`task_finish`, () => {
    const stats = queue.getStats()
    activity.setStatus(
      `${stats.total}/${stats.peak} ${(
        stats.total / convertHrtime(process.hrtime(startQueries)).seconds
      ).toFixed(2)} queries/second`
    )
  })
}

const processQueries = async (queryJobs, activity) => {
  const queue = queryQueue.createBuildQueue()
  reportStats(queue, activity)
  await queryQueue.processBatch(queue, queryJobs)
}

const createStaticQueryJob = (state, queryId) => {
  const component = state.staticQueryComponents.get(queryId)
  const { hash, id, query, componentPath } = component
  return {
    id: hash,
    hash,
    query,
    componentPath,
    context: { path: id },
  }
}

const processStaticQueries = async (queryIds, { state, activity }) => {
  state = state || store.getState()
  await processQueries(
    queryIds.map(id => createStaticQueryJob(state, id)),
    activity
  )
}

const createPageQueryJob = (state, page) => {
  const component = state.components.get(page.componentPath)
  const { path, componentPath, context } = page
  const { query } = component
  return {
    id: path,
    query,
    isPage: true,
    componentPath,
    context: {
      ...page,
      ...context,
    },
  }
}

const processPageQueries = async (queryIds, { state, activity }) => {
  state = state || store.getState()
  // Make sure we filter out pages that don't exist. An example is
  // /dev-404-page/, whose SitePage node is created via
  // `internal-data-bridge`, but the actual page object is only
  // created during `gatsby develop`.
  const pages = _.filter(queryIds.map(id => state.pages.get(id)))
  await processQueries(
    pages.map(page => createPageQueryJob(state, page)),
    activity
  )
}

/////////////////////////////////////////////////////////////////////
// Listener for gatsby develop

// Initialized via `startListening`
let listenerQueue

/**
 * Run any dirty queries. See `calcQueries` for what constitutes a
 * dirty query
 */
const runQueuedQueries = () => {
  if (listenerQueue) {
    const state = store.getState()
    const { staticQueryIds, pageQueryIds } = groupQueryIds(
      calcDirtyQueryIds(state)
    )
    const pages = _.filter(pageQueryIds.map(id => state.pages.get(id)))
    const queryJobs = [
      ...staticQueryIds.map(id => createStaticQueryJob(state, id)),
      ...pages.map(page => createPageQueryJob(state, page)),
    ]
    listenerQueue.push(queryJobs)
  }
}

/**
 * Starts a background process that processes any dirty queries
 * whenever one of the following occurs:
 *
 * 1. A node has changed (but only after the api call has finished
 * running)
 * 2. A component query (e.g by editing a React Component) has
 * changed
 *
 * For what constitutes a dirty query, see `calcQueries`
 */
const startListeningToDevelopQueue = () => {
  // We use a queue to process batches of queries so that they are
  // processed consecutively
  let graphqlRunner = null
  const developQueue = queryQueue.createDevelopQueue(() => {
    if (!graphqlRunner) {
      graphqlRunner = new GraphQLRunner(store)
    }
    return graphqlRunner
  })
  listenerQueue = new Queue((queryJobs, callback) =>
    queryQueue
      .processBatch(developQueue, queryJobs)
      .then(() => callback(null))
      .catch(callback)
  )

  emitter.on(`API_RUNNING_QUEUE_EMPTY`, runQueuedQueries)
  ;[
    `DELETE_CACHE`,
    `CREATE_NODE`,
    `DELETE_NODE`,
    `DELETE_NODES`,
    `SET_SCHEMA_COMPOSER`,
    `SET_SCHEMA`,
    `ADD_FIELD_TO_NODE`,
    `ADD_CHILD_NODE_TO_PARENT_NODE`,
  ].forEach(eventType => {
    emitter.on(eventType, event => {
      graphqlRunner = null
    })
  })
}

const enqueueExtractedQueryId = pathname => {
  extractedQueryIds.add(pathname)
}

const getPagesForComponent = componentPath => {
  const state = store.getState()
  return [...state.pages.values()].filter(
    p => p.componentPath === componentPath
  )
}

const enqueueExtractedPageComponent = componentPath => {
  const pages = getPagesForComponent(componentPath)
  // Remove page data dependencies before re-running queries because
  // the changing of the query could have changed the data dependencies.
  // Re-running the queries will add back data dependencies.
  boundActionCreators.deleteComponentsDependencies(
    pages.map(p => p.path || p.id)
  )
  pages.forEach(page => enqueueExtractedQueryId(page.path))
  runQueuedQueries()
}

module.exports = {
  calcInitialDirtyQueryIds,
  groupQueryIds,
  processStaticQueries,
  processPageQueries,
  startListeningToDevelopQueue,
  runQueuedQueries,
  enqueueExtractedQueryId,
  enqueueExtractedPageComponent,
}
