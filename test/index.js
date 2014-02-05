/* global describe, before, it */
'use strict';

var fs = require('fs'),
  zlib = require('zlib'),
  chai = require('chai'),
  es = require('event-stream'),
  gutil = require('gulp-util'),
  expect = chai.expect;

require('mocha');

delete require.cache[require.resolve('../')];

var awspublish = require('../');

describe('gulp-awspublish', function () {

  this.timeout(5000);

  var credentials = fs.readFileSync('aws-credentials.json', 'utf8'),
      publisher = awspublish.create(JSON.parse(credentials)),
      cacheFile = '.awspublish-' + publisher.client.bucket;

  // remove files
  before(function(done) {
    try { fs.unlinkSync(cacheFile); } catch (err) {}
    publisher._cache = {};
    publisher.client.deleteMultiple([
      'test/hello.txt',
      'test/hello2.txt',
      'test/hello.txtgz'
    ], done);
  });

  describe('Publish', function() {

    it('should produce gzip file with s3 headers', function (done) {

      var gzip = awspublish.gzip();
      var srcFile = new gutil.File({
        path: '/test/hello.txt',
        base: '/',
        contents: new Buffer('hello world')
      });

      gzip.write(srcFile);
      gzip
        .pipe(es.writeArray(function(err, files) {
          expect(err).not.to.exist;
          expect(files).to.have.length(1);
          expect(files[0]).to.not.eq(srcFile);
          expect(files[0].path).to.eq(srcFile.path + 'gz');
          expect(files[0].s3.path).to.eq('test/hello.txtgz');
          expect(files[0].s3.headers['Content-Encoding']).to.eq('gzip');

          // compare uncompressed to srcFile
          zlib.unzip(files[0].contents, function(err, buf) {
            var newFileContent = buf.toString('utf8', 0, buf.length),
                srcFileContent = srcFile.contents.toString('utf8', 0, srcFile.contents.length);
            expect(newFileContent).to.eq(srcFileContent);
            done();
          });
        }));

      gzip.end();
    });

    it('should upload gzip file', function (done) {
      var gzip = awspublish.gzip(),
          stream = gzip.pipe(publisher.publish());

      gzip.write(new gutil.File({
        path: '/test/hello.txt',
        base: '/',
        contents: new Buffer('hello world')
      }));

      stream
        .pipe(es.writeArray(function(err, files) {
          expect(err).not.to.exist;
          expect(files).to.have.length(1);
          publisher.client.headFile('test/hello.txtgz', function(err, res) {
            expect(res.headers.etag).to.exist;
            done(err);
          });
        }));

      gzip.end();
    });

    it('should create new file on s3 with headers', function (done) {

      var headers = {
        'Cache-Control': 'max-age=315360000, no-transform, public'
      };

      var stream = publisher.publish(headers);
      stream.write(new gutil.File({
        path: '/test/hello.txt',
        base: '/',
        contents: new Buffer('hello world')
      }));

      stream.write(new gutil.File({
        path: '/test/hello2.txt',
        base: '/',
        contents: new Buffer('hello world')
      }));

      stream
        .pipe(es.writeArray(function(err, files) {
          expect(err).not.to.exist;
          expect(files).to.have.length(2);
          expect(files[0].s3.path).to.eq('test/hello.txt');
          expect(files[0].s3.state).to.eq('create');
          expect(files[0].s3.headers['Cache-Control']).to.eq(headers['Cache-Control']);
          expect(files[0].s3.headers['x-amz-acl']).to.eq('public-read');
          expect(files[0].s3.headers['Content-Type']).to.eq('text/plain');
          expect(files[0].s3.headers['Content-Length']).to.eq(files[0].contents.length);
          publisher.client.headFile('/test/hello.txt', function(err, res) {
            expect(res.headers.etag).to.exist;
            done(err);
          });
        }));

      stream.end();
    });

    it('should update exsiting file on s3', function (done) {
      var stream = publisher.publish();
      stream.pipe(es.writeArray(function(err, files) {
        expect(err).not.to.exist;
        expect(files).to.have.length(1);
        expect(files[0].s3.state).to.eq('update');
        done(err);
      }));

      stream.write(new gutil.File({
        path: '/test/hello.txt',
        base: '/',
        contents: new Buffer('hello world 2')
      }));

      stream.end();
    });

    it('should skip file update', function (done) {
      var stream = publisher.publish();
      stream.pipe(es.writeArray(function(err, files) {
        expect(err).not.to.exist;
        expect(files).to.have.length(1);
        expect(files[0].s3.state).to.eq('skip');
        done(err);
      }));

      stream.write(new gutil.File({
        path: '/test/hello.txt',
        base: '/',
        contents: new Buffer('hello world 2')
      }));

      stream.end();
    });

    it('should add cache file', function (done) {
      var stream = publisher.publish(),
          cache = stream.pipe(publisher.cache());

      stream.write(new gutil.File({
        path: '/test/hello.txt',
        base: '/',
        contents: new Buffer('hello world 2')
      }));

      cache.on('finish', function() {
        expect(publisher._cache).to.have.ownProperty('test/hello.txt');
        done();
      });

      stream.end();
    });

    it('should mark file as cached', function (done) {
      var stream = publisher.publish();
      stream.pipe(es.writeArray(function(err, files) {
        expect(err).not.to.exist;
        expect(files).to.have.length(1);
        expect(files[0].s3.state).to.eq('cache');
        done(err);
      }));

      stream.write(new gutil.File({
        path: '/test/hello.txt',
        base: '/',
        contents: new Buffer('hello world 2')
      }));

      stream.end();
    });

  });

  describe('Sync', function() {

    // remove files
    before(function(done) {
      publisher.client.deleteMultiple([
        'test/hello.txt',
        'test/hello2.txt',
        'test/hello.txtgz'
      ], done);
    });

    // add some dummy file
    ['bar', 'foo', 'bim', 'boum'].forEach(function (name) {
      var filename = name + '.txt',
          headers = {'Content-Type': 'text/plain'};
      before(function(done) {
        publisher.client.putBuffer(name, filename, headers, done);
      });
    });

    it('should sync bucket with published data', function(done) {
      var stream = gutil.noop();

      stream
        .pipe(publisher.sync())
        .pipe(es.writeArray(function(err, arr) {
          expect(err).to.not.exist;
          var deleted = arr.filter(function (file) {
            return file.s3 && file.s3.state === 'delete';
          }).map(function (file) {
            return file.s3.path;
          }).sort().join(' ');

          expect(deleted).to.eq('boum.txt foo.txt');
          done(err);
        }));

      stream.write({ s3: { path: 'bim.txt' } });
      stream.write({ s3: { path: 'bar.txt' } });
      stream.end();
    });
  });


});