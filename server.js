var http = require('http');


http.createServer(function (req, res) {
  var proxyRequest = http.request({
    'hostname': 'www.google.com'

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

