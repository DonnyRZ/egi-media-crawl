'use strict';

module.exports = {
  ...require('./config'),
  ...require('./normalize'),
  ...require('./extractAnchors'),
  ...require('./candidateIndex'),
  ...require('./scoring'),
  ...require('./aggregateEvents'),
};
