var http = require('http');
var url  = require('url');
var clone  = require('clone');
var redis  = require('redis'),
    client = redis.createClient();
var events = require('events'),
    eventEmitter = new events.EventEmitter();


function computeKey(host, path, method) {
    return method + ':' + host + ':' + path;
}

function makeKeyField(key, prefix) {
    return prefix + ':' + key;
}

function getHeadersKey(key) {
    return makeKeyField(key, 'headers');
}

function getBodyKey(key) {
    return makeKeyField(key, 'body');
}

function canStore(headers) {
    // rules are
    // if not private
    // and not no-store nor no cache
    // then use the value in this order
    // s-maxage
    // max-age
    // expires
    // Exceptions are 
    // must-revalidate
    // proxy-revalidate

    if( headers['cache-control'] === undefined ) {
        return false;
    }

    var params = headers['cache-control'].trim().split(',');

    var values = {};

    for(idx in params) {
        if( params[idx].indexOf('=') !== -1 ) {
            var parts = params[idx].trim().split('=');
            key = parts[0].trim();
            val = parts[1].trim();
            if( key == 's-maxage' || key == 'max-age' ) {
                val = parseInt(val);
            }
            values[ key ] = val;
        } else {
            values[ params[idx].trim() ] = 1;
        }
    }
    
    if( 
        values['private'] !== undefined ||
        values['no-cache'] !== undefined ||
        values['no-store'] !== undefined 
    ) {
        // Do not cache
        return false;
    }

    if( values['s-maxage'] !== undefined ) {
        return values['s-maxage'];
    }
    else if( values['max-age'] !== undefined ) {
        return values['max-age'];
    }
    
    return false;
}

var doRequest = function doRequest(req, res, cacheKey) {
  var host = req.headers['host'];

  delete req.headers['host'];

  var proxyRequest = http.request({
    'method': req.method,
    'hostname': host,
    'headers': req.headers,
    'path': req.url
  }, function(proxyResponse) {

    delete proxyResponse.headers['content-length'];
    
    var headers = clone(proxyResponse.headers);
    headers['x-cache'] = 'MISS';

    res.writeHead(proxyResponse.statusCode, headers);
    
    var cacheIt = canStore(proxyResponse.headers);
    
    if( cacheIt ) {
        var headersKey = getHeadersKey(cacheKey);
        var bodyKey = getBodyKey(cacheKey);

        client.hset(headersKey, 'statusCode', proxyResponse.statusCode);
        client.hset(headersKey, 'headers', JSON.stringify(proxyResponse.headers));
        client.expire(headersKey, cacheIt.toString());

        client.del(bodyKey);
    }

    proxyResponse.setEncoding('utf8');
    proxyResponse.on('data', function (chunk) {
        res.write(chunk);
        if( cacheIt ) {
            client.append(bodyKey, chunk);
        }
    });

    proxyResponse.on('end', function(){
        res.end();
    });
  });
  proxyRequest.end();
}

eventEmitter.on('doRequest', doRequest);

http.createServer(function (req, res) {

  var cacheKey = computeKey(req.headers['host'], req.url, req.method);
  
  if( (req.headers['cache-control'] !== undefined 
    && req.headers['cache-control'] == 'no-cache')
    || req.method != 'GET' 
  ) {
    // Force request
    eventEmitter.emit('doRequest', req, res, cacheKey);
  } else {

      client.hgetall(getHeadersKey(cacheKey), function(err, results) {
        
        if( results !== null ) {
            var headers = JSON.parse(results['headers']);
            headers['x-cache'] = 'HIT';
            res.writeHead(results['statusCode'], headers);
            client.get(getBodyKey(cacheKey), function(err, reply) {
                res.write(reply);
            });
            res.end();
        } else {

          eventEmitter.emit('doRequest', req, res, cacheKey);

        }

      });
  }


}).listen(1337, '127.0.0.1');
console.log('Server running at http://127.0.0.1:1337/');

