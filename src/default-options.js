
module.exports = {
  skipFullUpsert: !/^(false|no|0)$/i.test(process.env.SKIP_FULL_UPSERT),
  logger: {
    log() {
      console.log.apply(console, Array.prototype.slice.call(arguments));
    }
  },
  mongo: {
    uri: process.env.MONGO_URL ||
          '',
        uriEntireCollectionRead: process.env.MONGO_FULL_READ_URL ||
          '',
        db: process.env.MONGO_DB || 'orchard-mile-staging',
        collection: process.env.MONGO_COLLECTION || 'products',
    extra: process.env.MONGO_EXTRA || '?ssl=true&replicaSet=rs-ds251978',
  },
  redisLastOp: process.env.REDISCLOUD_URL && {
    url: process.env.REDISCLOUD_URL,
    key: process.env.REDIS_KEY || 'mongoListenerLastOp'
  }
};
