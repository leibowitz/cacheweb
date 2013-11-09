var http = require('http');
var url  = require('url');
var redis  = require('redis'),
    client = redis.createClient();

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
    var params = headers['cache-control'].split(',');
    var seconds = false;
    for(idx in params) {
        if( params[idx].indexOf('private') !== -1 ) {
            return false;
        }
        if( params[idx].indexOf('no-cache') !== -1 ) {
            return false;
        }
        if( params[idx].indexOf('no-store') !== -1 ) {
            return false;
        }
        if( params[idx].indexOf('=') !== -1 ) {
            var parts = params[idx].split('=');
            if( parts[0] == 'max-age' ) {
                seconds = parts[1];
            }
            else if( parts[0] == 's-maxage' ) {
                seconds = parts[1];
            }
        }
    }
    return seconds;
}

http.createServer(function (req, res) {

  var host = req.headers['host'];

  var cacheKey = computeKey(host, req.url, req.method);

  client.hgetall(getHeadersKey(cacheKey), function(err, results) {
    
    if( results !== null ) {
        res.writeHead(results['statusCode'], JSON.parse(results['headers']));
        client.get(getBodyKey(cacheKey), function(err, reply) {
            res.write(reply);
        });
        res.end();
    } else {

      delete req.headers['host'];

      var proxyRequest = http.request({
        'method': req.method,
        'hostname': host,
        'headers': req.headers,
        'path': req.url
      }, function(proxyResponse) {

        delete proxyResponse.headers['content-length'];

        res.writeHead(proxyResponse.statusCode, proxyResponse.headers);
        
        var cacheIt = canStore(proxyResponse.headers);
        
        if( cacheIt ) {
            var headersKey = getHeadersKey(cacheKey);
            var bodyKey = getBodyKey(cacheKey);

            client.hset(headersKey, 'statusCode', proxyResponse.statusCode);
            client.hset(headersKey, 'headers', JSON.stringify(proxyResponse.headers));
            client.expire(keadersKey, cacheIt);

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

  });


}).listen(1337, '127.0.0.1');
console.log('Server running at http://127.0.0.1:1337/');

