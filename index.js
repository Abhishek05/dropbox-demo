#!/usr/bin/env node

"use strict";

require('./helper')
let fs = require('fs')
let express = require('express')
let morgan = require('morgan')
let trycatch = require('trycatch')
let wrap = require('co-express')
let bodyParser = require('simple-bodyparser')
let path = require('path')
let mime = require('mime-types')
let rim = require('rimraf')
let mkp = require('mkdirp')
let archiver = require('archiver')
let argv = require('yargs').argv
//let dir = argv.dir
let chokidar = require('chokidar')
let net = require('net')
let JsonSocket = require('json-socket');

const ROOT_DIR = path.resolve(argv.dir || process.cwd())

let clients = []

function* main() {
    console.log('Starting server...')
    let app = express()
    app.use(morgan('dev'))
    app.use((req, res, next) => {
        trycatch(next, e => {
            console.log(e.stack)
            res.writeHead(500)
            res.end(e.stack)
        })
    })
    app.get('*', wrap(setProperties), wrap(sendHeaders), wrap(read), wrap(setFileMissingError))

    app.head('*', wrap(setProperties), wrap(sendHeaders), (req, res) => res.end())

    app.put('*', wrap(setProperties), wrap(sendHeaders), wrap(setDirectoryDetails), wrap(create))

    app.post('*', wrap(setProperties), wrap(sendHeaders), wrap(setDirectoryDetails), wrap(update))

    app.del('*', wrap(setProperties), wrap(sendHeaders), wrap(remove))
    let port = 8000
    app.listen(port)
    console.log('LISTENING @ http://127.0.0.1:'+port)
    let tcpport = 8001
    let server = net.createServer()
    server.listen(tcpport)
    console.log('LISTENING @ http://127.0.0.1:'+tcpport+' as well')
    server.on('connection', (socket) => {
        console.log("Connection: " + socket.remoteAddress + ":" + socket.remotePort)
        socket = new JsonSocket(socket)
        clients.push(socket)

        socket.on('message', (message) => {
            console.log('Message: ' + message)
        })

        socket.on('end', () => {
            console.log("End connection")
            clients.splice(clients.indexOf(socket), 1)
        })
    })

      chokidar.watch(ROOT_DIR, {ignored: /[\/\\]\./})
            .on('add', (path) => {
                let message = {"action": "create", "path": path.replace(ROOT_DIR, ""),
                                                  "type": "file", "updated": (new Date).getTime()}
                sendMessageToClient(clients, message)
            }).on('change', (path) => {
               let message = {"action": "update", "path": path.replace(ROOT_DIR, ""),
                                                   "type": "file", "updated": (new Date).getTime()}
                sendMessageToClient(clients, message)
            }).on('unlink', (path) => {
               let message = {"action": "delete", "path": path.replace(ROOT_DIR, ""),
                                                    "type": "file", "updated": (new Date).getTime()}
              sendMessageToClient(clients, message)
            }).on('addDir', (path) => {
               let message = {"action": "create", "path": path.replace(ROOT_DIR, ""),
                                                   "type": "dir", "updated": (new Date).getTime()}
              sendMessageToClient(clients, message)
            }).on('unlinkDir', (path) => {
               let message = {"action": "delete", "path": path.replace(ROOT_DIR, ""),
                                                      "type": "dir", "updated": (new Date).getTime()}
               sendMessageToClient(clients, message)
            })
}

function sendMessageToClient(clients, message) {
    clients.forEach((client) => {
        client.sendMessage(message)
    })
}

function* setProperties(req, res, next){
    req.filepath = path.resolve(path.join(ROOT_DIR,  req.url))
  try  {
    req.stat = yield fs.promise.stat(req.filepath)
  }catch(e){
    req.stat = null
  }
  req.accept = req.headers['accept']
  next();
}

function* sendHeaders(req, res, next) {
      console.log("Setting header");
      if(req.stat){
          if(req.stat.isDirectory()){
            let files = yield fs.promise.readdir(req.filepath)
            res.body = JSON.stringify(files)
            res.setHeader( 'Content-Type', 'application/json' )
            res.setHeader( 'Content-Length', res.body.length )
          }else{
            let contentType = mime.contentType(path.extname(req.filepath))
            res.setHeader( 'Content-Type', contentType )
            res.setHeader( 'Content-Length', req.stat.size )
          }
     }
     next();
}

function* setDirectoryDetails(req, res, next){

  let filepath = req.filepath
  let endswithslash = filepath.charAt(filepath.length -1) === path.sep
  let hasExt = path.extname(filepath) !== ''
  req.isDir = endswithslash || !hasExt
  req.dirPath = req.isDir ? filepath : path.dirname(filepath)
  next()
}

function* setFileMissingError(req, res, next){
  if(!req.stat){
      res.status(405);
      res.send('file does not exists');
  }
  next()
}

function* read(req, res, next) {
  if(req.stat){
          if(res.body){
              if(req.accept && req.accept === 'application/x-gtar'){
                let archive = archiver('zip')
                archive.pipe(res);
                archive.bulk([
                    { expand: true, cwd: 'source', src: ['**']}
                ])
                yield archive.promise.finalize()
                res.end(data)

              }else{
                res.json(res.body)
              }
          }else{
            let data = yield fs.promise.readFile(req.filepath)
            res.end(data)
            //let readstream = yield fs.promise.createReadStream(req.filepath)
            //readstream.pipe(res)
          }
  }
  next();
}

function* create(req, res, next) {
    if(req.stat){
      return res.send(405,'file exists');
    }
    yield mkp.promise(req.dirPath)
    if(!req.isDir){
      req.pipe(fs.createWriteStream(req.filepath))
    }
    res.end()
}

function* update(req, res) {
  if(!req.stat){
    return res.send(405,'file does not exists');
  }
  if(req.isDir){
    return res.send(405,'Path is a directory');
  }

  yield fs.promise.truncate(req.filepath, 0)
  req.pipe(fs.createWriteStream(req.filepath))
  res.end()
}

function* remove(req, res, next) {
    if(req.stat){
      if(req.stat.isDirectory()){
        yield rim.promise(req.filepath)
        //res.end()
      }else{
        yield fs.promise.unlink(req.filepath)
        res.end()
      }
    }else{
      res.status(405);
      res.send('file does not exists');
      res.end()
    }
   next();
}

module.exports = main
