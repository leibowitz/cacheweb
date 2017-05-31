
const crypto = require('crypto'),
          fs = require("fs");
var http = require('http');
var https = require('https');
var dns = require('dns');
var url  = require('url');
var net = require('net');
var tls = require('tls');
var clone  = require('clone');
var httpProxy = require('http-proxy');
var proxy = new httpProxy.RoutingProxy();
//var redis  = require('redis'),
//    client = redis.createClient(6379, '127.0.0.1', {detect_buffers: true});
var events = require('events'),
  eventEmitter = new events.EventEmitter();

var privateKey = fs.readFileSync('privatekey.pem');
var certificate = fs.readFileSync('certificate.pem');
var opts = { key: privateKey, cert: certificate };



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

function splitString(str, separator) {
  return str.trim().split(separator);
}

function getHeaderValues(str) {
  var params = splitString(str, ',');

  var values = {};

  for(var idx in params) {
    var parts = params[idx].trim().split('=');
    if( parts.length > 0 ) {
      var key = parts[0].trim();
      if( parts.length >= 2 ) {
        val = parts[1].trim();
        values[ key ] = val;
      } else {
        values[ key ] = true;
      }
    }
  }

  return values;
}

function canStore(statusCode, headers, cacheKey) {
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

  var values = getHeaderValues(headers['cache-control']);

  if( 
      values.private !== undefined ||
      values['no-cache'] !== undefined ||
      values['no-store'] !== undefined 
    ) {
      // Do not cache
      return false;
    }

  if( values['s-maxage'] !== undefined ) {
    return parseInt(values['s-maxage']);
  }
  else if( values['max-age'] !== undefined ) {
    return parseInt(values['max-age']);
  }

  return false;
}

function isNotModified(req, resp) {
  if( req['if-modified-since'] !== undefined && 
      resp['last-modified'] !== undefined ) {
        var condDate = new Date(req['if-modified-since']);
        var lastModified = new Date(resp['last-modified']);
        return condDate >= lastModified;
      }
  return false;
}

function isConditional(req) {

  if( req['if-modified-since'] !== undefined || 
      req['if-none-match'] !== undefined ) {
        return true;
      }
  return false;
}

function isBinary(headers) {
  var binary = false;

  if( headers['content-type'] !== undefined ) {
    var contentParts = headers['content-type'].split(';');
    var contentType = contentParts[0].split('/');
    if(contentType[0] == 'image') {
      binary = true;
    }
  }

  return binary;
}

function getHost(headers)
{
  var parts = headers.host.trim().split(':');
  return parts[0].trim();
}

function getPort(headers)
{
  var parts = headers.host.trim().split(':');
  return (parts[1] || '80').trim();
}

function getTimeNow()
{
  var now = new Date();
  return now.getTime();
}

function getAge(timestamp)
{
  return Math.floor((getTimeNow() - timestamp)/1000);
}

var cacheResponse = function cacheResponse(cacheKey, proxyResponse, cacheIt) {

  if( cacheIt ) {
    var headersKey = getHeadersKey(cacheKey);
    var bodyKey = getBodyKey(cacheKey);


    /*client.hmset(headersKey, 
                'statusCode', proxyResponse.statusCode,
                'headers', JSON.stringify(proxyResponse.headers),
                'timestamp', getTimeNow()
    );
    client.expire(headersKey, cacheIt.toString());

    client.del(bodyKey);*/
  }

};

var cacheContent = function cacheContent(cacheKey, cacheIt, chunk) {
  if( cacheIt ) {
    var bodyKey = getBodyKey(cacheKey);
    //client.append(bodyKey, chunk);
  }
};

var expireContent = function expireContent(cacheKey, cacheIt) {
  if( cacheIt ) {
    var bodyKey = getBodyKey(cacheKey);
    //client.expire(bodyKey, cacheIt);
  }
};

var noHost = function noHost(req, res, host, port) {
  // Redirect to localhost
  if(debug) {
    console.log('sending error to avoid request loop');
  }
  /*proxy.proxyRequest(req, res, {
    host: '127.0.0.1',
    port: '80'
    });*/
  // better stop now to avoid request loop
  res.writeHead(500, {});
  res.end();
};

var checkRequest = function checkRequest(req, res, host, port) {
  if(debug) {
    console.log('doing dns lookup');
  }

  dns.lookup(host, function (err, addresses) {
    if(debug) {
      console.log(addresses);
    }

    if (err) { console.log( err) };

    if( addresses == serverHostname && port == serverPort ) {
      eventEmitter.emit('noHost', req, res, host, port);
    } else {
      eventEmitter.emit('processRequest', req, res, host, port);
    }
  });

};

var doRequest = function doRequest(req, res, cacheKey, host, port) {

  if(debug) {
    console.log('doing http request to origin '+ host + ':' + port);
  }

  var urlinfo = url.parse(req.url);

  var options = {
    // Disable connection pooling
    //'agent': false,
    'method': req.method,
    'hostname': host,
    'port': port,
    //'headers': req.headers,
    'path': urlinfo.path
  };

  var httpclient = null;

  if(port == 443) {
    httpclient = https.request;
  } else {
    httpclient = http.request;
  }

  var proxyRequest = httpclient(options, function(proxyResponse) {

    var headers = clone(proxyResponse.headers);
    headers['x-cache'] = 'MISS';

    // Do not cache 304 response to conditional requests
    var cacheIt = 
      !isConditional(req.headers) || proxyResponse.statusCode != 304 ? 
      canStore(proxyResponse.statusCode, proxyResponse.headers, cacheKey) : false;
  
    if(debug) {
      console.log('got ' + proxyResponse.statusCode + ' response, will '+(cacheIt?'':'not')+' cache');
    }

    eventEmitter.emit('cacheResponse', cacheKey, proxyResponse, cacheIt);

    var encoding = 'utf8';

    if(debug) {
      console.log('sending response');
    }

    res.writeHead(proxyResponse.statusCode, headers);


    if( isBinary(headers) ) {
      encoding = 'binary';
      proxyResponse.setEncoding(encoding);
    }

    proxyResponse.on('data', function (chunk) {
      res.write(chunk, encoding);
      eventEmitter.emit('cacheContent', cacheKey, cacheIt, chunk);
    });

    proxyResponse.on('end', function(){
      eventEmitter.emit('expireContent', cacheKey, cacheIt);
      res.end();
    });

  });

  proxyRequest.end();
  if(debug) {
    console.log('done');
  }

};

var processRequest = function processRequest(req, res, host, port) {

  var cacheKey = computeKey(req.headers.host, req.url, req.method);

  if(debug) {
    console.log(req.method);
  }
  if( (req.headers['cache-control'] !== undefined && 
       req.headers['cache-control'] == 'no-cache') || 
         ( req.method != 'GET' && req.method != 'HEAD' )
    ) {
      if(debug) {
        console.log('request is asking for origin, proxying');
      }
      // Force request
      proxy.proxyRequest(req, res, {
        host: host,
        port: port
      });
    } else {
      if(debug) {
        console.log('checking in cache');
      }
      /*client.hgetall(getHeadersKey(cacheKey), function(err, results) {

        if( results !== null ) {
          if(debug) {
            console.log('found in cache');
          }

          var headers = JSON.parse(results.headers);
          headers['x-cache'] = 'HIT';
          headers.age = getAge(results.timestamp);

          if( isNotModified(req.headers, headers) ) {
            if(debug) {
              console.log('not modified');
            }
            // answer to conditional requests
            headers['content-length'] = 0;
            res.writeHead(304, headers);
            res.end();
          }
          else {

            if( req.method == 'HEAD') {
              if(debug) {
                console.log('head request');
              }
              res.end();
            } else {
              if(debug) {
                console.log('returning full result from cache');
              }
              var binary = isBinary(headers);
              var encoding = binary ? 'binary' : 'utf8';

              res.writeHead(results.statusCode, headers);

              client.get(getBodyKey(cacheKey), function(err, reply) {
                if(reply !== null) {
                  res.write(reply, encoding);
                }
                res.end();
              });
            }

          }
        } else {*/

          if(debug) {
            console.log('not found in cache');
          }

          eventEmitter.emit('doRequest', req, res, cacheKey, host, port);

        /*}

      });*/
    }


};

var serverPort = 80, 
    serverHostname = '0.0.0.0',
    debug = true;

if( process.argv.length > 2 ) {
  serverHostname = process.argv[2];
}

if( process.argv.length > 3 ) {
  serverPort = process.argv[3];
}

console.log('Running on http://'+serverHostname+':'+serverPort+'/');


// HTTP

var server = http.createServer(function (req, res) {
  console.log(req.headers);

  var host = getHost(req.headers);
  var port = getPort(req.headers);

  if(port == serverPort) { 
    port = 80;
  }

  eventEmitter.emit('checkRequest', req, res, host, port);
});

server.on('error', function(err){
  console.log(err);
});


server.on('connect', function(req, cltSocket, head) {
    console.log('connect to ' + req.url);

  var srvUrl = url.parse('http://' + req.url);
    console.log('opening socket to ' + srvUrl.hostname);

var options = {
  // These are necessary only if using the client certificate authentication
  key: fs.readFileSync('privatekey.pem'),
  cert: fs.readFileSync('certificate.pem')//,

  // This is necessary only if the server uses the self-signed certificate
  //ca: [ fs.readFileSync('server-cert.pem') ]
};

  var srvSocket = net.connect(srvUrl.port, srvUrl.hostname, function() {
    cltSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                    'Proxy-agent: Node-Proxy\r\n' +
                    '\r\n');
    srvSocket.write(head);

    //srvSocket.pipe(cltSocket);
    //cltSocket.pipe(srvSocket);
  });
cltSocket.on('data', function(data) {
  srvSocket.write(data);
});
cltSocket.on('end', function() {
  srvSocket.end()
});
srvSocket.on('data', function(data) {
  console.log(data.toString());
  cltSocket.write(data);
});
srvSocket.on('end', function() {
  cltSocket.end()
});

srvSocket.on('error', function(err){
  console.log(err);
});

cltSocket.on('error', function(err){
  console.log(err);
});

});
server.on('upgrade', function(req, socket, head) {
    console.log('upgrade requested');

  socket.write('HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
               'Upgrade: WebSocket\r\n' +
               'Connection: Upgrade\r\n' +
               '\r\n');

  //socket.pipe(socket); // echo back
    // I don't know how to forward the request and send the response to client
});

server.listen(serverPort, serverHostname);


eventEmitter.on('doRequest', doRequest);
eventEmitter.on('checkRequest', checkRequest);
eventEmitter.on('processRequest', processRequest);
eventEmitter.on('cacheResponse', cacheResponse);
eventEmitter.on('cacheContent', cacheContent);
eventEmitter.on('expireContent', expireContent);
eventEmitter.on('noHost', noHost);

console.log('Server running at http://'+serverHostname+':'+serverPort+'/');


// HTTPS
var httpsserverPort = 8443;

var httpsserver = https.createServer(opts, function (req, res) {
  console.log(req.headers);
  var host = getHost(req.headers);
  var port = getPort(req.headers);
  port = 443;

  eventEmitter.emit('checkRequest', req, res, host, port);
});

httpsserver.on('error', function(err){
  console.log(err);
});

httpsserver.listen(httpsserverPort, serverHostname);



console.log('Server running at https://'+serverHostname+':'+httpsserverPort+'/');

