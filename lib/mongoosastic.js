'use strict'

const elasticsearch = require('elasticsearch')
const Generator = require('./mapping-generator')
const generator = new Generator()
const serialize = require('./serialize')
const events = require('events')
const util = require('util')
const nop = function nop () {}

function isString (subject) {
  return typeof subject === 'string'
}

function isStringArray (arr) {
  return arr.filter && arr.length === (arr.filter(item => typeof item === 'string')).length
}

function getMapping (schema) {
  let retMapping = {}
  generator.generateMapping(schema, (err, mapping) => {
    if (err) {
      // no handling needed
    }
    retMapping = mapping
  })

  return retMapping
}

function createEsClient (options) {
  const esOptions = {}

  if (util.isArray(options.hosts)) {
    esOptions.host = options.hosts
  } else {
    esOptions.host = {
      host: options && options.host ? options.host : 'localhost',
      port: options && options.port ? options.port : 9200,
      protocol: options && options.protocol ? options.protocol : 'http',
      auth: options && options.auth ? options.auth : null,
      keepAlive: false
    }
  }

  esOptions.log = (options ? options.log : null)

  return new elasticsearch.Client(esOptions)
}

function createMappingIfNotPresent (options, cb) {
  const client = options.client
  const indexName = options.indexName
  const typeName = options.typeName
  const schema = options.schema
  const settings = options.settings
  const properties = options.properties

  generator.generateMapping(schema, (ignoredErr, mapping) => {
    const completeMapping = {}
    completeMapping[typeName] = mapping

    if (properties) {
      Object.keys(properties).map(key => {
        completeMapping[typeName].properties[key] = properties[key]
      })
    }

    client.indices.exists({
      index: indexName
    }, (err, exists) => {
      if (err) {
        return cb(err)
      }

      if (exists) {
        return client.indices.putMapping({
          index: indexName,
          type: typeName,
          body: completeMapping
        }, cb)
      }
      return client.indices.create({
        index: indexName,
        body: settings
      }, indexErr => {
        if (indexErr) {
          return cb(indexErr)
        }

        client.indices.putMapping({
          index: indexName,
          type: typeName,
          body: completeMapping
        }, cb)
      })
    })
  })
}

function hydrate (res, model, options, cb) {
  const results = res.hits
  const resultsMap = {}
  const ids = results.hits.map((result, idx) => {
    resultsMap[result._id] = idx
    return result._id
  })

  const query = model.find({
    _id: {
      $in: ids
    }
  })
  const hydrateOptions = options.hydrateOptions

  // Build Mongoose query based on hydrate options
  // Example: {lean: true, sort: '-name', select: 'address name'}
  Object.keys(hydrateOptions).forEach(option => {
    query[option](hydrateOptions[option])
  })

  query.exec((err, docs) => {
    let hits
    let docsMap = {}

    if (err) {
      return cb(err)
    }

    if (!docs || docs.length === 0) {
      results.hits = []
      res.hits = results
      return cb(null, res)
    }

    if (hydrateOptions.sort) {
      // Hydrate sort has precedence over ES result order
      hits = docs
    } else {
      // Preserve ES result ordering
      docs.forEach(doc => {
        docsMap[doc._id] = doc
      })
      hits = results.hits.map(result => docsMap[result._id])
    }

    if (options.highlight || options.hydrateWithESResults) {
      hits.forEach(doc => {
        const idx = resultsMap[doc._id]
        if (options.highlight) {
          doc._highlight = results.hits[idx].highlight
        }
        if (options.hydrateWithESResults) {
          // Add to doc ES raw result (with, e.g., _score value)
          doc._esResult = results.hits[idx]
          if (!options.hydrateWithESResults.source) {
            // Remove heavy load
            delete doc._esResult._source
          }
        }
      })
    }

    results.hits = hits
    res.hits = results
    cb(null, res)
  })
}

function deleteByMongoId (options, cb) {
  const index = options.index
  const type = options.type
  const client = options.client
  const model = options.model
  const routing = options.routing
  let tries = options.tries

  client.delete({
    index: index,
    type: type,
    id: model._id.toString(),
    routing: routing
  }, (err, res) => {
    if (err && err.status === 404) {
      if (tries <= 0) {
        model.emit('es-removed', err, res)
        return cb(err)
      }
      options.tries = --tries
      setTimeout(() => {
        deleteByMongoId(options, cb)
      }, 500)
    } else {
      model.emit('es-removed', err, res)
      cb(err)
    }
  })
}

function Mongoosastic (schema, pluginOpts) {
  let options = pluginOpts || {}

  let bulkTimeout
  let bulkBuffer = []
  let esClient
  let populate = options && options.populate
  let mapping = getMapping(schema)

  let indexName = options && options.index
  let typeName = options && options.type
  let alwaysHydrate = options && options.hydrate
  let defaultHydrateOptions = options && options.hydrateOptions
  let bulk = options && options.bulk
  let filter = options && options.filter
  let transform = options && options.transform
  let routing = options && options.routing

  let customProperties = options && options.customProperties
  let customSerialize = options && options.customSerialize
  let indexAutomatically = !(options && options.indexAutomatically === false)
  let saveOnSynchronize = !(options && options.saveOnSynchronize === false)
  // This hashmap is used mainly for updates that can't be tracked easily because
  // we don't have access to the instance of the document in the pre hook
  const updateBuffer = {}

  if (options.esClient) {
    esClient = options.esClient
  } else {
    esClient = createEsClient(options)
  }

  function setIndexNameIfUnset (model) {
    const modelName = model.toLowerCase()
    if (!indexName) {
      indexName = `${modelName}s`
    }

    if (!typeName) {
      typeName = modelName
    }
  }

  function hasPendingUpdate (target) {
    return updateBuffer[target._id] && updateBuffer[target._id].length
  }

  function addUpdateToBuffer (target, update) {
    updateBuffer[target._id] = updateBuffer[target._id] || []
    updateBuffer[target._id].push(update)
  }

  function flushUpdateBuffer (target) {
    const update = {}

    if (!updateBuffer[target._id]) {
      return update
    }

    for (const change of updateBuffer[target._id]) {
      Object.assign(update, change)

      for (const key of Object.keys(change)) {
        // For referenced documents, we want to copy the selected attributes
        // that we receive from the DB instead of unintentionally dumping the referenced ObjectId
        if (isReferencedDocument(key)) {
          Object.assign(update, {[key]: target[key]})
        }
      }
    }

    delete updateBuffer[target._id]

    return update
  }

  function preSave (next) {
    this.mongoosasticNew = this.isNew
    this.mongoosasticModifiedPaths = this.modifiedPaths()
    next()
  }

  function postSave (doc) {
    let _doc
    function onIndex (err, res) {
      if (!filter || !filter(doc)) {
        doc.emit('es-indexed', err, res)
      } else {
        doc.emit('es-filtered', err, res)
      }
    }

    if (doc) {
      _doc = new doc.constructor(doc)

      _doc.mongoosasticNew = doc.mongoosasticNew
      _doc.mongoosasticModifiedPaths = doc.mongoosasticModifiedPaths

      if (populate && populate.length) {
        populate.forEach(populateOpts => {
          _doc.populate(populateOpts)
        })
        _doc.execPopulate().then(popDoc => {
          popDoc.index(onIndex)
        }).catch(onIndex)
      } else {
        _doc.index(onIndex)
      }
    }
  }

  function isReferencedDocument (path) {
    if (populate && populate.length) {
      for (const populateOpts of populate) {
        if (path === populateOpts.path) {
          return true
        }
      }
    }

    return false
  }

  function clearBulkTimeout () {
    clearTimeout(bulkTimeout)
    bulkTimeout = undefined
  }

  function bulkAdd (instruction) {
    bulkBuffer.push(instruction)

    // Return because we need the doc being indexed
    // Before we start inserting
    if (instruction.index && instruction.index._index) {
      return
    }

    if (bulkBuffer.length >= ((bulk && bulk.size) || 1000)) {
      schema.statics.flush()
      clearBulkTimeout()
    } else if (bulkTimeout === undefined) {
      bulkTimeout = setTimeout(() => {
        schema.statics.flush()
        clearBulkTimeout()
      }, (bulk && bulk.delay) || 1000)
    }
  }

  function bulkDelete (opts, cb) {
    bulkAdd({
      delete: {
        _index: opts.index || indexName,
        _type: opts.type || typeName,
        _id: opts.model._id.toString(),
        _routing: opts.routing
      }
    })
    cb()
  }

  function bulkIndex (opts) {
    bulkAdd({
      index: {
        _index: opts.index || indexName,
        _type: opts.type || typeName,
        _id: opts._id.toString(),
        _routing: opts.routing
      }
    })
    bulkAdd(opts.model)
  }

  function bulkUpdate (opts) {
    bulkAdd({
      update: {
        _index: opts.index || indexName,
        _type: opts.type || typeName,
        _id: opts._id.toString(),
        _routing: opts.routing
      }
    })
    bulkAdd({doc: opts.model})
  }

  function generatePartialUpdate (model, modifiedPaths) {
    const update = {}
    modifiedPaths = modifiedPaths || []

    for (const path of modifiedPaths) {
      update[path] = model[path]
    }

    Object.assign(update, flushUpdateBuffer(model))

    return update
  }

  function partialUpdate (opts, cb) {
    opts.body = {doc: opts.body}
    esClient.update(opts, cb)
  }

  /**
   * ElasticSearch Client
   */
  schema.statics.esClient = esClient

  /**
   * Create the mapping. Takes an optional settings parameter
   * and a callback that will be called once the mapping is created

   * @param settings Object (optional)
   * @param cb Function
   */
  schema.statics.createMapping = function createMapping (inSettings, inCb) {
    let cb = inCb
    let settings = inSettings
    if (arguments.length < 2) {
      cb = inSettings || nop
      settings = undefined
    }

    setIndexNameIfUnset(this.modelName)

    createMappingIfNotPresent({
      client: esClient,
      indexName: indexName,
      typeName: typeName,
      schema: schema,
      settings: settings,
      properties: customProperties
    }, cb)
  }

  /**
   * @param options  Object (optional)
   * @param cb Function
   */
  schema.methods.index = function schemaIndex (inOpts, inCb) {
    let index
    let type
    let serialModel
    let cb = inCb
    let opts = inOpts
    let _serialize = serialize

    if (arguments.length < 2) {
      cb = inOpts || nop
      opts = {}
    }

    if (filter && filter(this)) {
      return this.unIndex(cb)
    }

    if (typeof customSerialize === 'function') {
      _serialize = customSerialize
    }

    setIndexNameIfUnset(this.constructor.modelName)

    index = opts.index || indexName
    type = opts.type || typeName

    const actions = {
      index: {bulk: bulkIndex, index: esClient.index.bind(esClient)},
      update: {bulk: bulkUpdate, index: partialUpdate}
    }

    let model = this

    let action = 'index'

    if (this.mongoosasticNew === false || hasPendingUpdate(model)) {
      action = 'update'
      model = generatePartialUpdate(model, this.mongoosasticModifiedPaths)
    }

    /**
     * Serialize the model, and apply transformation
     */
    serialModel = _serialize(model, mapping)
    if (transform) serialModel = transform(serialModel, this)

    const _opts = {
      index: index,
      type: type
    }
    if (routing) {
      _opts.routing = routing(this)
    }

    if (bulk) {
      _opts.model = serialModel
      _opts._id = this._id
      actions[action].bulk(_opts)
      setImmediate(() => cb(null, this))
    } else {
      _opts.id = this._id.toString()
      _opts.body = serialModel
      actions[action].index(_opts, cb)
    }
  }

  /**
   * Unset elasticsearch index
   * @param options - (optional) options for unIndex
   * @param cb - callback when unIndex is complete
   */
  schema.methods.unIndex = function unIndex (inOpts, inCb) {
    let opts = inOpts
    let cb = inCb

    if (arguments.length < 2) {
      cb = inOpts || nop
      opts = {}
    }

    setIndexNameIfUnset(this.constructor.modelName)

    opts.index = opts.index || indexName
    opts.type = opts.type || typeName
    opts.model = this
    opts.client = esClient
    opts.tries = opts.tries || 3
    if (routing) {
      opts.routing = routing(this)
    }

    if (bulk) {
      bulkDelete(opts, cb)
    } else {
      deleteByMongoId(opts, cb)
    }
  }

  /**
   * Delete all documents from a type/index
   * @param options - (optional) specify index/type
   * @param cb - callback when truncation is complete
   */
  schema.statics.esTruncate = function esTruncate (inOpts, inCb) {
    let opts = inOpts
    let cb = inCb
    let esQuery

    if (arguments.length < 2) {
      cb = inOpts || nop
      opts = {}
    }

    setIndexNameIfUnset(this.modelName)

    opts.index = opts.index || indexName
    opts.type = opts.type || typeName

    esQuery = {
      body: {
        query: {
          match_all: {}
        }
      },
      index: opts.index,
      type: opts.type
    }

    esClient.search(esQuery, (err, res) => {
      if (err) {
        return cb(err)
      }
      if (res.hits.total) {
        res.hits.hits.forEach(doc => {
          opts.model = doc
          if (routing) {
            doc._source._id = doc._id
            opts.routing = routing(doc._source)
          }
          bulkDelete(opts, nop)
        })
      }
      cb()
    })
  }

  /**
   * Synchronize an existing collection
   *
   * @param query - query for documents you want to synchronize
   */
  schema.statics.synchronize = function synchronize (inQuery, inOpts) {
    let em = new events.EventEmitter()
    let closeValues = []
    let counter = 0
    let stream
    let query = inQuery || {}
    let close = function close () {
      em.emit.apply(em, ['close'].concat(closeValues))
    }

    let _saveOnSynchronize = inOpts &&
      inOpts.saveOnSynchronize !== undefined ? inOpts.saveOnSynchronize : saveOnSynchronize

    // Set indexing to be bulk when synchronizing to make synchronizing faster
    // Set default values when not present
    bulk = {
      delay: bulk && bulk.delay || 1000,
      size: bulk && bulk.size || 1000,
      batch: bulk && bulk.batch || 50
    }

    setIndexNameIfUnset(this.modelName)

    stream = this.find(query).batchSize(bulk.batch).cursor()

    stream.on('data', doc => {
      stream.pause()
      counter++

      function onIndex (indexErr, inDoc) {
        counter--
        if (indexErr) {
          em.emit('error', indexErr)
        } else {
          em.emit('data', null, inDoc)
        }
        stream.resume()
      }

      doc.on('es-indexed', onIndex)
      doc.on('es-filtered', onIndex)

      if (_saveOnSynchronize) {
        // Save document with Mongoose first
        doc.save(err => {
          if (err) {
            counter--
            em.emit('error', err)
            return stream.resume()
          }
        })
      } else {
        postSave(doc)
      }
    })

    stream.on('close', (pA, pB) => {
      let closeInterval
      closeValues = [pA, pB]
      closeInterval = setInterval(() => {
        if (counter === 0 && bulkBuffer.length === 0) {
          clearInterval(closeInterval)
          close()
          bulk = options && options.bulk
        }
      }, 1000)
    })

    stream.on('error', err => {
      em.emit('error', err)
    })

    return em
  }

  /**
   * ElasticSearch search function
   *
   * Wrapping schema.statics.es_search().
   *
   * @param inQuery - query object to perform search with
   * @param inOpts - (optional) special search options, such as hydrate
   * @param inCb - callback called with search results
   */
  schema.statics.search = function search (inQuery, inOpts, inCb) {
    let cb = inCb
    let opts = inOpts
    let query = inQuery === null ? undefined : inQuery
    let esSearch
    let fullQuery

    if (arguments.length === 2) {
      cb = arguments[1]
      opts = {}
    }

    fullQuery = {
      query: query
    }

    esSearch = schema.statics.esSearch.bind(this)

    return esSearch(fullQuery, opts, cb)
  }

  /**
   * ElasticSearch true/raw search function
   *
   * Elastic search query: provide full query object.
   * Useful, e.g., for paged requests.
   *
   * @param inQuery - **full** query object to perform search with
   * @param inOpts - (optional) special search options, such as hydrate
   * @param inCb - callback called with search results
     */
  schema.statics.esSearch = function (inQuery, inOpts, inCb) {
    let _this = this
    let cb = inCb
    let opts = inOpts
    let esQuery
    let query = inQuery === null ? undefined : inQuery

    if (arguments.length === 2) {
      cb = arguments[1]
      opts = {}
    }

    opts.hydrateOptions = opts.hydrateOptions || defaultHydrateOptions || {}

    setIndexNameIfUnset(this.modelName)

    esQuery = {
      body: query,
      index: opts.index || indexName,
      type: opts.type || typeName
    }

    if (opts.routing) {
      esQuery.routing = opts.routing
    }

    if (opts.highlight) {
      esQuery.body.highlight = opts.highlight
    }

    if (opts.suggest) {
      esQuery.body.suggest = opts.suggest
    }

    if (opts.aggs) {
      esQuery.body.aggs = opts.aggs
    }

    if (opts.min_score) {
      esQuery.body.min_score = opts.min_score
    }

    Object.keys(opts).forEach(opt => {
      if (!opt.match(/(hydrate|sort|aggs|highlight)/) && opts.hasOwnProperty(opt)) {
        esQuery[opt] = opts[opt]
      }

      if (opts.sort) {
        if (isString(opts.sort) || isStringArray(opts.sort)) {
          esQuery.sort = opts.sort
        } else {
          esQuery.body.sort = opts.sort
        }
      }
    })

    esClient.search(esQuery, (err, res) => {
      if (err) {
        return cb(err)
      }

      if (alwaysHydrate || opts.hydrate) {
        hydrate(res, _this, opts, cb)
      } else {
        cb(null, res)
      }
    })
  }

  schema.statics.esCount = function esCount (inQuery, inCb) {
    let cb = inCb
    let query = inQuery
    let esQuery

    setIndexNameIfUnset(this.modelName)

    if (!cb && typeof query === 'function') {
      cb = query
      query = {
        match_all: {}
      }
    }

    esQuery = {
      body: {
        query: query
      },
      index: indexName,
      type: typeName
    }

    esClient.count(esQuery, cb)
  }

  schema.statics.flush = function flush (inCb) {
    let cb = inCb || nop

    esClient.bulk({
      body: bulkBuffer
    }, cb)

    bulkBuffer = []
  }

  schema.statics.refresh = function refresh (inOpts, inCb) {
    let cb = inCb
    let opts = inOpts
    if (arguments.length < 2) {
      cb = inOpts || nop
      opts = {}
    }

    setIndexNameIfUnset(this.modelName)
    esClient.indices.refresh({
      index: opts.index || indexName
    }, cb)
  }

  function postRemove (doc) {
    if (!doc) {
      return
    }

    const opts = {
      index: indexName,
      type: typeName,
      tries: 3,
      model: doc,
      client: esClient
    }
    if (routing) {
      opts.routing = routing(doc)
    }

    setIndexNameIfUnset(doc.constructor.modelName)

    if (bulk) {
      bulkDelete(opts, nop)
    } else {
      deleteByMongoId(opts, nop)
    }
  }

  /**
   * Use standard Mongoose Middleware hooks
   * to persist to Elasticsearch
   */
  function setUpMiddlewareHooks (inSchema) {
    /**
     * Remove in elasticsearch on remove
     */
    inSchema.post('remove', postRemove)
    inSchema.post('findOneAndRemove', postRemove)

    /**
     * Save in elasticsearch on save.
     */
    inSchema.post('save', postSave)
    inSchema.post('findOneAndUpdate', postSave)
    inSchema.post('insertMany', (docs) => {
      docs.forEach((doc) => postSave(doc))
    })
    inSchema.post('update', function () {
      this.targets.forEach(target => {
        this.model.findById(target._id).then(doc => {
          postSave(doc)
        })
      })
    })

    /**
     * Records the isNew attribute to determine whether we should update or index
     * and also what should be updated
     */
    inSchema.pre('save', preSave)
    inSchema.pre('findOneAndUpdate', function (next) {
      this.model.findOne(this.getQuery(), '_id').then(target => {
        if (target) {
          addUpdateToBuffer(target, this.getUpdate())
        }

        next()
      })
    })
    inSchema.pre('update', function (next) {
      const update = this.getUpdate()

      bulk = {
        batch: bulk && bulk.batch || 50
      }

      this.targets = []
      this.model.find(this.getQuery(), '_id').lean().cursor({batchSize: bulk.batch}).eachAsync(doc => {
        this.targets.push(doc)

        if (update.$set) {
          addUpdateToBuffer(doc, update.$set)
        }
      }).then(() => {
        next()
      })
    })
  }

  if (indexAutomatically) {
    setUpMiddlewareHooks(schema)
  }
}

module.exports = Mongoosastic
