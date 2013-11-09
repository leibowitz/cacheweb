var http = require('http');
var url  = require('url');


http.createServer(function (req, res) {

  var host = req.headers['host'];
  delete req.headers['host'];

  var proxyRequest = http.request({
    'method': req.method,
    'hostname': host,
    'headers': req.headers,
    'path': req.url
  }, function(proxyResponse) {

    delete proxyResponse.headers['content-length'];
    res.writeHead(proxyResponse.statusCode, proxyResponse.headers);
    proxyResponse.setEncoding('utf8');
    proxyResponse.on('data', function (chunk) {
        res.write(chunk);
    });
    proxyResponse.on('end', function(){
        res.end();
    });
  }
  );
  proxyRequest.end();
}).listen(1337, '127.0.0.1');
console.log('Server running at http://127.0.0.1:1337/');

