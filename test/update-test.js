'use strict'

const mongoose = require('mongoose')
const should = require('should')
const elasticsearch = require('elasticsearch')
const esClient = new elasticsearch.Client()
const config = require('./config')
const Schema = mongoose.Schema
const async = require('async')
const mongoosastic = require('../lib/mongoosastic')

const OwnerSchema = new Schema({
  name: {
    type: String,
    es_indexed: true
  },
  phone: {
    type: String,
    es_indexed: true
  }
})

const CardSchema = new Schema({
  name: {
    type: String,
    es_indexed: true,
    es_type: 'keyword'
  },
  type: {
    type: String,
    es_indexed: true,
    es_type: 'keyword'
  },
  owner: {
    type: Schema.Types.ObjectId,
    ref: 'Owner',
    es_schema: OwnerSchema,
    es_indexed: true
  }
})

CardSchema.plugin(mongoosastic, {
  populate: [
    {path: 'owner'}
  ]
})

const Owner = mongoose.model('Owner', OwnerSchema)
const Card = mongoose.model('Card', CardSchema)

describe('Updates', function () {
  before(function (done) {
    mongoose.connect(config.mongoUrl, function () {
      async.forEach([Card, Owner], function (model, cb) {
        model.remove(cb)
      }, function () {
        config.deleteIndexIfExists(['cards'], function () {
          Card.createMapping(function (err, response) {
            should.exists(response)
            response.should.not.have.property('error')
            done()
          })
        })
      })
    })
  })

  after(function (done) {
    mongoose.disconnect()
    Card.esClient.close()
    esClient.close()
    done()
    config.deleteIndexIfExists(['cards'], done)
  })

  describe('update', function () {
    before(function (done) {
      async.map([
        {name: 'John', phone: '111-111-1111'},
        {name: 'Carl', phone: '222-222-2222'},
        {name: 'Alex', phone: '333-333-3333'}
      ], function (owner, cb) {
        const _owner = new Owner(owner)
        _owner.save(cb)
      }, function (err, people) {
        if (err) {
          done(err)
        } else {
          let i = 0
          async.forEach(people, function (owner, cb) {
            ++i
            config.createModelAndEnsureIndex(Card, {
              name: 'Card #' + i,
              type: 'magic',
              owner: owner._id
            }, cb)
          }, done)
        }
      })
    })

    it('should update an object in the index', function (done) {
      Card.update({name: 'Card #1'}, {type: 'monster'}, function () {
        setTimeout(function () {
          Card.search({
            query_string: {
              query: 'name:Card #1'
            }
          }, function (err, results) {
            results.hits.total.should.eql(1)
            results.hits.hits[0]._source.name.should.eql('Card #1')
            results.hits.hits[0]._source.type.should.eql('monster')
            done()
          })
        }, config.INDEXING_TIMEOUT)
      })
    })

    it('should update multiple objects in the index', function (done) {
      Card.update({}, {type: 'trap'}, function () {
        setTimeout(function () {
          Card.search({}, function (err, results) {
            results.hits.total.should.eql(3)
            results.hits.hits.forEach(function (obj) {
              obj._source.type.should.eql('trap')
            })
            done()
          })
        }, config.INDEXING_TIMEOUT)
      })
    })
  })
})
