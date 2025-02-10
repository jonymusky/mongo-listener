'use strict';

var fs = require('fs');
var os = require('os');
var http = require('http');
var _ = require('lodash');
const { MongoClient } = require('mongodb');
var mongoCursorProcessing = require('mongo-cursor-processing');
var Timestamp = require('bson-timestamp');
var redis = require('redis');
var Processor = require('./processor');
var defaultOptions = require('./default-options');

class Listener {
  constructor(options) {
    this.options = _.merge(_.cloneDeep(defaultOptions), options);
    this.processor = new Processor(this.options);
    this.client = false;
    this.connectClient();
    var self = this;
    this.processor.setDocGetter((id, done) => {
      self.client
        .db(self.options.mongo.db)
        .collection(self.options.mongo.collection)
        .findOne(id, done);
    });
  }

  log() {
    if (!this.options.logger) {
      return;
    }
    this.options.logger.log.apply(
      this.options.logger,
      Array.prototype.slice.call(arguments)
    );
  }

  start() {
    var options = {
      ns: this.options.mongo.db + '.' + this.options.mongo.collection,
      poolSize: 1,
      reconnectTries: 2,
    };
    this.getLastOpTimestamp((err, since) => {
      if (err) {
        this.log(new Error('error reading lastop: ' + err));
      }
      if (since) {
        options.since = since;
      }
      if (options.since) {
        this.log('info', 'resuming from timestamp ' + since);
      } else {
        if (!this.options.skipFullUpsert) {
          this.log(
            'info',
            'unable to determine last op, processing entire collection...'
          );
          this.processEntireCollection();
        } else {
          this.log('info', 'unable to determine last op');
        }
      }

      this.watchCollection();
      this.startHttpServer();
    });
  }

  setLastOpTimestamp(ts) {
    this.lastOp = ts;
    if (this.options.redisLastOp) {
      if (!this.redisClient) {
        this.redisClient = redis.createClient(this.options.redisLastOp.url);
      }
      this.redisClient.set(this.options.redisLastOp.key, ts.toString());
      return;
    }
    fs.writeFileSync('lastop.json', ts.toString());
  }

  startHttpServer() {
    if (!this.options.http || !this.options.http.port) {
      return;
    }
    var port = this.options.http.port;
    this.httpServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      var data = {
        db: this.options.mongo.db,
        collection: this.options.mongo.collection,
        memoryUsage: process.memoryUsage(),
        loadavg: os.loadavg(),
        lastOp: this.lastOp || 'unknown',
        queueSize: this.processor.processQueue.length,
      };
      res.write(JSON.stringify(data, null, 2));
      res.end();
    });
    this.httpServer.listen(port);
    this.log('server listening at http://localhost:' + port);
  }

  getLastOpTimestamp(done) {
    var ts;
    function readFromFile() {
      if (fs.existsSync('lastop.json')) {
        try {
          ts = Timestamp.fromString(fs.readFileSync('lastop.json').toString());
        } catch (err) {
          this.log(new Error('error reading lastop file: ' + err.toString()));
        }
      }
      done(null, ts);
    }

    if (this.options.redisLastOp) {
      try {
        if (!this.redisClient) {
          this.redisClient = redis.createClient(this.options.redisLastOp.url);
          this.redisClient.on('error', (err) => {
            this.log(new Error('Redis client error: ' + err.toString()));
          });
        }
        this.redisClient.get(this.options.redisLastOp.key, (err, value) => {
          if (err) {
            return done(err);
          }
          if (value) {
            try {
              ts = Timestamp.fromString(value.toString());
            } catch (err) {
              this.log(
                new Error('error reading lastop redis key: ' + err.toString())
              );
            }
          }
          done(null, ts);
        });
        return;
      } catch (err) {
        return done(err);
      }
    }

    readFromFile.call(this);
  }

  async connectClient() {
    if (!this.client) {
      const uri =
        this.options.mongo.uriEntireCollectionRead +
        '/' +
        this.options.mongo.db;
      this.client = new MongoClient(uri, {
        useNewUrlParser: true,
        replicaSet: this.options.mongo.replicaSet,
        authSource: this.options.mongo.authSource,
        retryWrites: true,
        writeConcern: 'majority',
        ssl: true,
      });

      await this.client.connect();
    }
  }

  async watchCollection() {
    try {
      // Define a pipeline to filter changes
      const pipeline = [
        {
          $match: {
            'ns.coll': this.options.mongo.collection,
            $or: [
              // For updates, only process if there’s at least one updated field that is not in the ignored list.
              {
                $expr: {
                  $gt: [
                    {
                      $size: {
                        $filter: {
                          input: {
                            $objectToArray: '$updateDescription.updatedFields',
                          },
                          as: 'field',
                          cond: {
                            $not: {
                              $or: [
                                {
                                  $regexMatch: {
                                    input: '$$field.k',
                                    regex: /^modifiedAt$/,
                                  },
                                },
                                {
                                  $regexMatch: {
                                    input: '$$field.k',
                                    regex: /^styles\.\d+\.modifiedAt$/,
                                  },
                                },
                                {
                                  $regexMatch: {
                                    input: '$$field.k',
                                    regex: /^styles\.\d+\.crawlerInfo\.jobId$/,
                                  },
                                },
                                {
                                  $regexMatch: {
                                    input: '$$field.k',
                                    regex:
                                      /^styles\.\d+\.crawlerInfo\.lastCrawled$/,
                                  },
                                },
                                {
                                  $regexMatch: {
                                    input: '$$field.k',
                                    regex:
                                      /^styles\.\d+\.variants\.\d+\.stockUpdatedAt$/,
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                    0,
                  ],
                },
              },
            ],
          },
        },
      ];

      const changeStream = this.client
        .db(this.options.mongo.db)
        .collection(this.options.mongo.collection)
        .watch(pipeline, {
          fullDocument: 'updateLookup',
        });
      changeStream.on('change', (changeEvent) => {
        const operationType = changeEvent.operationType;
        const fullDoc = changeEvent.fullDocument;

        this.processor.processDoc(fullDoc, false, (err) => {
          if (err) {
            this.log(new Error('error processing change:', changeEvent));
            this.log(err);
          }
        });
        if (changeEvent.wallTime) {
          this.setLastOpTimestamp(new Date(changeEvent.wallTime).getTime());
        }
      });

      // Handle errors
      changeStream.on('error', (error) => {
        this.log(error);
      });

      this.log('info', 'Change stream started');
    } catch (err) {
      this.log('error', 'Failed to start change stream:', err);
    }
  }

  processEntireCollection() {
    var db;
    var cursor;
    if (this.options.entireCollectionCursor) {
      cursor = this.options.entireCollectionCursor;
    } else {
      cursor = this.collection().find();
    }
    var count = 0;
    var startTime = new Date().getTime();

    var processor = this.processor;
    function processDocument(doc, done) {
      processor.processDoc(doc, true, (err) => {
        count++;
        done(err);
      });
    }

    var concurrency = this.options.maxBatchSize || 5000;
    mongoCursorProcessing(cursor, processDocument, concurrency, (err) => {
      if (err) {
        this.log(
          new Error('error processing entire collection: ' + err.toString())
        );
        process.exit(1);
      }
      var elapsedSeconds = Math.round(
        (new Date().getTime() - startTime) / 1000
      );
      this.log(
        'info',
        'entire collection processed (' +
          count +
          ' documents, ' +
          Math.floor(elapsedSeconds / 60) +
          'm' +
          (elapsedSeconds % 60) +
          's).'
      );
      if (db) {
        db.close();
      }
    });
  }
}

module.exports = Listener;
