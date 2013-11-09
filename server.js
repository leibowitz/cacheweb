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

        client.hset(getHeadersKey(cacheKey), 'statusCode', proxyResponse.statusCode);
        client.hset(getHeadersKey(cacheKey), 'headers', JSON.stringify(proxyResponse.headers));

        proxyResponse.setEncoding('utf8');
        proxyResponse.on('data', function (chunk) {
            res.write(chunk);
            client.append(getBodyKey(cacheKey), chunk);
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

