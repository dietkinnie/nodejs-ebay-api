/**
 * default response parser, for JSON.
 * (and supporting helpers)
 * for XML responses, should be run through `./xml-converter` first.
 */

var
  _ = require('lodash'),
  util = require('util'),
  debug = require('debug')('ebay:parser'),

  _errors = require('./errors'),
  EbaySystemError = _errors.EbaySystemError,
  EbayRequestError = _errors.EbayRequestError,
  EbayClientError = _errors.EbayClientError,

  knownArrayKeysByApiEndpoint = require('./key-lists').knownArrayKeysByApiEndpoint;


/*
helper: find an array containing only special key-value pairs
e.g. 'galleryURL' (makes it easier to handle in DB)
*/
function _isArrayOfValuePairs(el) {
  if (_.isArray(el)) {
    if (_.all(el, _isValuePair)) return true;
  }
  return false;
}

/*
helper: identify a structure returned from the API:
  { @key:KEY, __value__:VALUE } => want to turn into { KEY: VALUE }
  (and array of these into single obj)
*/
function _isValuePair(el) {
  if (_.isObject(el) && _.size(el) === 2) {
    var keys = _.keys(el);
    if (new RegExp(/^@/).test(keys[0]) && keys[1] === '__value__') {
      return true;
    }
  }
  return false;
}


/*
helper to filter the keys that get flattened.
*/
function _canFlattenKey(key, requestContext) {
  //debug('_canFlattenKey?', key, requestContext);

  // assume that '*Array' and '*List' elements are arrays.
  if (/Array$/.test(key) || /List$/.test(key)) return false;

  // per-endpoint blacklist of known array keys.
  if (requestContext != null && requestContext.serviceName && requestContext.opType &&
      knownArrayKeysByApiEndpoint[requestContext.serviceName] != null &&
      knownArrayKeysByApiEndpoint[requestContext.serviceName][requestContext.opType] != null &&
      _.contains(knownArrayKeysByApiEndpoint[requestContext.serviceName][requestContext.opType], key)) {
    return false;
  }

  // otherwise assume it can be flattened if there's a single value.
  return true;
}


/*
 convert `OrderArray: [ Order: [...] ]` structure to `Orders: []`.
 @param parentObj: the obj *containing* the key to be restructured.
 @param key: the key within the object to fix.
 modifies byref - no return.
*/
function _flattenSillyArray(parentObj, key, requestContext) {
  //debug('_flattenSillyArray', key, parentObj[key]);
  var subKey = key.replace(/Array$/, '');   // e.g. 'Order' from 'OrderArray'
  var newKey = subKey + 's';                // e.g. 'Orders'

  parentObj[newKey] = parentObj[key][0][subKey];
  delete parentObj[key];

  // might have already been flattened...
  if (!_.isArray(parentObj[newKey])) parentObj[newKey] = [ parentObj[newKey] ];

  parentObj[newKey] = parentObj[newKey].map(function(subObj) {
    return exports.flatten(subObj, -1, requestContext);
  });
}


function _convertAmountStructure(el, requestContext) {
  if (_.isArray(el)) {
    return el.map(function(subEl) {
      return _convertAmountStructure(subEl);
    });
  }

  if (el.hasOwnProperty('_') && el.hasOwnProperty('$')) {
    el.amount = +el._;
    delete el._;
    _.extend(el, el['$']);    // {currencyID}
    delete el['$'];
  }
  return el;
}


function _castTypes(el) {
  if (_.isString(el)) {
    if (!isNaN(el)) el = +el;   // numeric string to number
    else if (el === 'true') el = true;
    else if (el === 'false') el = false;
  }
  return el;
}


/*
 recursively turn 1-element arrays/objects into flat values/objects.
 intended to handle flaw of XML->JSON conversion, that everything becomes an array.
 NOTE this is risky/complicated, because it has to make assumptions
  about what *should* remain an array,
  so some items might be structured differently depending on number of values.
  helpers like `canFlattenKey()` try to mitigate this risk.

 also transforms numbers and booleans from strings to types.
*/
exports.flatten = function flatten(el, maxDepth, requestContext, _depth) {
  if (_.isUndefined(_depth)) _depth = 0;
  if (_.isUndefined(maxDepth) || maxDepth < 1) maxDepth = 10;

  if (_depth === 0) debug('flattening', el, {maxDepth: maxDepth, requestContext: requestContext});

  if (_depth <= maxDepth) {

    // flatten 1-item arrays.
    // note: this is dangerous, means responses w/ single value can look different from multiple values.
    // trying to mitigate with `canFlattenKey()` check below.
    if (_.isArray(el) && el.length === 1) {
      el = _.first(el);
    }

    // weird value-pair structure:
    // turn `{ @key:KEY, __value__:VALUE }` into `{ KEY: VALUE }`
    if (_isValuePair(el)) {
      var values = _.values(el);
      debug('converting key-value pair', el);
      el = {};
      el[ values[0] ] = values[1];
    }

    //// previous fix just creates an array of these. we want a clean key:val obj.
    //// so, is this an array of special value-pairs?
    //// TODO - disabled this b/c old and inefficient - understand where it was needed, and try to optimize.
    //if (_isArrayOfValuePairs(el)) {
    //  var fixEl = {};
    //  _(el).each(function(pair) {
    //    _.extend(fixEl, flatten(pair, maxDepth, requestContext, _depth + 1));   // fix each, combine
    //  });
    //  el = fixEl;
    //}

    // flatten sub-elements
    if (_.isObject(el) && !_.isArray(el)) {
      debug('--is an object', el);
      _.forOwn(el, function(childEl, childKey) {
        debug('--child', childKey, childEl);
        // special cases
        if (/Array$/.test(childKey)) {
          _flattenSillyArray(el, childKey, requestContext);  // on parent, byref
        }
        else if (/(Amount|Cost|Price)/.test(childKey)) {
          el[childKey] = _convertAmountStructure(childEl, requestContext);
        }

        if (_canFlattenKey(childKey, requestContext)) {
          el[childKey] = flatten(childEl, maxDepth, requestContext, _depth + 1);
        }
        // can't flatten [presumed] array itself, but can still flatten its children.
        // @REVIEW: this causes weird skipping behavior, where grandchildren are flattened before higher levels,
        // so can't assume that lower levels haven't been flattened yet!
        else if (_.isArray(childEl)) {
          debug('---grandchildren', childKey, childEl, el[childKey]===childEl, typeof childEl.map);
          el[childKey] = childEl.map(function(grandChildEl) {
            return flatten(grandChildEl, maxDepth, requestContext, _depth + 1);
          });
        }
      });
    }

    if (_.isArray(el)) {
      el = el.map(function(childEl) {
        return flatten(childEl, maxDepth, requestContext, _depth + 1);
      });
    }

  } //depth

  el = _castTypes(el);

  debug('flattened to', el);
  return el;
};


/*
parse API responses. differs by query type.
@param data: response, converted to (or originally in) JSON.
@param requestContext: context on the request.
@param callback: gets `null, data` in success case, and `error, data` on error case.
  - error can be from response or parsing failure. (see error types.)
  - callback is actually called immediately/synchronously - just using to have 2 return values in error case.
*/
exports.parseResponseJson = function(data, requestContext, callback) {
  debug('parsing response json', data, requestContext);

  var flatten = exports.flatten;

  // flattening can be slow with big responses;
  // don't necessarily want to flatten all the way up front.
  // (maybe better to let app pick the keys it wants and flatten only them.)
  // depth here is arbitrary.
  data = flatten(data, 5, requestContext);

  // find the response key.
  // (is probably `{requestContext.opType}Response`)
  var responseKey = _(data).keys().find(function(key) {
    return /[a-zA-Z]+Response$/.test(key);
  }) || requestContext.opType + 'Response';

  debug('looking for response key', responseKey);

  data = data[responseKey];

  if (_.isUndefined(data)) {
    // assume this is a failure of the client to parse the response properly.
    throw new EbayClientError("Response missing " + responseKey + " element");
  }

  //
  // 'Ack', 'Errors', (and maybe 'errorMessage'?) indicate errors.
  // see http://developer.ebay.com/devzone/xml/docs/Reference/ebay/Errors/ErrorMessages.htm
  //
  var
    errorMessage,   // build a string
    errorClassification = 'RequestError',  // 'RequestError' or 'SystemError'
    errors;         // error object(s) in response.

  // normalize to uppercase
  if (!_.isUndefined(data.ack)) {
    data.Ack = data.ack;
    delete data.ack;
  }
  if (!_.isUndefined(data.Ack)) {
    data.Ack = flatten(data.Ack, -1, requestContext);
  }

  //
  // note: docs say,
  //  "Both Success and Warning indicate that the request was successful.
  //   However, a value of Warning means that something occurred
  //   that may affect your application or the user."
  // for now, treat Warning as a failure.
  //
  if (_.isUndefined(data.Ack) || data.Ack !== 'Success') {
    //
    // handle all different ways errors can be represented
    //

    // Trading, Shopping, Finding(?)
    if (!_.isUndefined(data.Errors)) {
      errors = _.isArray(data.Errors) ? data.Errors : [data.Errors];

      // build composite message.
      errorMessage = errors.map(function(errorObj) {
        errorObj = flatten(errorObj, -1, requestContext);
        if (errorObj.ErrorClassification === 'SystemError') {
          errorClassification = 'SystemError';  // trumps RequestError
        }
        return errorObj.LongMessage + (errorObj.ErrorCode ? ' (' + errorObj.ErrorCode + ')' : '');
      }).join(', ');
    }

    // @review which API is this for?
    // (maybe a relic of JSON response, no longer relevant?)
    else if (!_.isUndefined(data.errorMessage)) {
      errorMessage = flatten(data.errorMessage, -1, requestContext);
      if (_.isObject(errorMessage)) errorMessage = util.inspect(errorMessage, true, 3);
      // TODO error code and classification in this format?
    }

    debug('response error', errorClassification, data.Ack, errorMessage);

    if (!errorMessage) errorMessage = util.format("Bad ack code: ", data.Ack);  // fallback

    if (errorClassification === 'SystemError') {
      return callback(new EbaySystemError("eBay API system error: " + errorMessage), data);
    }
    else {
      return callback(new EbayRequestError("eBay API request error: " + errorMessage), data);
    }
  }

  //
  // PER-OP PARSING
  //
  // ...?

  callback(null, data);
};