var Promise = require('bluebird');
var request = require('request');
var progress = require('progress');
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var tar = require('tar-fs');
var temp = require('temp');
var DecompressZip = require('decompress-zip');
var ncp = require('ncp').ncp;
var rimraf = require('rimraf');
var _ = require('lodash');

// Automatically track and cleanup files at exit
temp.track();
var isWin = /^win/.test(process.platform);

// one progressbar for all downloads
var bar;

var readFile = Promise.promisify(fs.readFile);
var writeFile = Promise.promisify(fs.writeFile);

module.exports = {
    checkCache: function(cachepath, files, indexFilePath) {
        var all = files.map(function(file) {
            return new Promise(function(resolve) {
                fs.exists(path.join(cachepath, file), resolve);
            });
        });
        return Promise.all(all)
            .then(function(array) {
                return Promise.resolve(_.every(array));
            })
            .then(function(ok) {
                if (!ok) {return Promise.resolve(false);}
                return readFile( indexFilePath, { encoding: 'utf8' }).then(function(file) {

                    return Promise.resolve(JSON.parse(file));
                }).catch(function(err) {
                    return Promise.resolve(false);
                });
                /*return new Promise(function(resolve, reject) {
                    fs.readFile(filename, [options], callback)#
                });*/

            });  
    },
    checkCacheSync: function(cachepath, files) {
        var missing;
        files.forEach(function(file) {
            if (missing) {
                return;
            }
            if (!fs.existsSync(path.join(cachepath, file))) {
                missing = true;
            }
        });

        return !missing;
    },
    clearProgressbar: function() {
        bar && bar.terminate();
        bar = null;
    },
    downloadAndUnpack: function(cachepath, url, indexFilePath) {
        var extention = path.extname(url),
            done = Promise.defer(),
            self = this,
            rq = request(url),
            len,
            stream;

        function format(statusCode) {
            return statusCode + ': ' + require('http').STATUS_CODES[statusCode];
        }

        rimraf.sync(cachepath);

        rq.proxy = true;
        rq.on('error', function(err) {
            bar && bar.terminate();
            done.reject(err);
        });
        rq.on('response', function (res) {
            len = parseInt(res.headers['content-length'], 10);
            if (res.statusCode !== 200) {
                done.reject({
                    statusCode: res.statusCode,
                    msg: 'Recieved status code ' + format(res.statusCode)
                });
            } else if (len) {
                if (!bar) {
                    bar = new progress('  downloading [:bar] :percent :etas', {
                        complete: '=',
                        incomplete: '-',
                        width: 20,
                        total: len
                    });
                } else {
                    bar.total += len;
                }
            }
        });
        rq.on('data', function(chunk) {
            len && bar && bar.tick(chunk.length);
        });

        //var temp_path = cachepath + '.nwdownload';

        if (extention === '.zip') {
            stream = temp.createWriteStream();

            stream.on('close', function() {
                if(done.promise.isRejected()) return;
                self.extractZip(stream.path, cachepath).then(self.stripRootFolder).then(function(files) {

                    self.saveModesIndex(indexFilePath, files.index).then(function() {
                        done.resolve(files.index);
                    }, function(err) {
                        done.reject(err);
                    });
                    //fs.rename(temp_path, cachepath, function(err, data) {
                        //if (err) {return done.reject(err);}
                        
                    //});
                }).catch(function(err) {
                    done.reject(err);
                });
            });

            rq.pipe(stream);
        }

        if (extention === '.gz') {
            rq.on('response', function(res) {
                if(res.statusCode !== 200) return;
                self.extractTar(res, cachepath).then(self.stripRootFolder).then(function(files) {
                    self.saveModesIndex(indexFilePath, files.index).then(function() {
                        done.resolve(files.index);
                    }, function(err) {
                        done.reject(err);
                    });


                    //fs.rename(temp_path, cachepath, function(err, data) {
                        //if (err) {return done.reject(err);}
                    //});
                    
                }).catch(function(err) {
                    done.reject(err);
                });
            });
        }

        return done.promise;
    },
    saveModesIndex: function(indexFilePath, index) {
        return writeFile( indexFilePath, JSON.stringify(index) ).then(function() {
            return Promise.resolve(index);
        });
    },
    extractTar: function(tarstream, destination) {
        var done = Promise.defer(),
            gunzip = zlib.createGunzip(),
            files = [];

        tarstream
            .pipe(gunzip)
            .on('error', function(err){
                done.reject(err);
            })
            .pipe(tar.extract(destination, {
                umask: (isWin ? false : 0),
                map: function(header) {
                    files.push({
                        path: header.name,
                        key: header.name,
                        mode: parseInt(header.mode, 10)
                    });
                    return header;
                }
            }))
            .on('finish', function() {
                done.resolve({ files: files, destination: destination });
            });

        return done.promise;
    },
    extractZip: function(zipfile, destination) {
        var files = [],
            done = Promise.defer();

        new DecompressZip(zipfile)
            .on('error', function(err){
                done.reject(err);
            })
            .on('extract', function(log) {
                // Setup chmodSync to fix permissions
                files.forEach(function(file) {
                    var fpath = path.join(destination, file.path);
                    fs.chmodSync(fpath, file.mode);
                });
                done.resolve({files:files, destination:destination});
            })
            .extract({
                path: destination,
                filter: function(entry) {
                    files.push({
                        path: entry.path,
                        key: entry.path,
                        mode: parseInt(entry.mode.toString(8),10)
                    });

                    return true;
                }
            });

        return done.promise;
    },
    stripRootFolder: function(extracted){
        var done = Promise.defer(),
            files = extracted.files,
            destination = extracted.destination,
            rootFiles = fs.readdirSync(destination),
            fromDir = path.join(destination, rootFiles.length === 1 ? rootFiles[0] : '');

        var modes_index;

        // strip out root folder if it exists
        if (rootFiles.length === 1 && fs.statSync(fromDir).isDirectory() ){
            // strip folder from files
            for (var i = 0; i < files.length; i++) {
                var file = files[i];
                file.path = path.relative(rootFiles[0], file.path);
                if (file.path === '') {
                    files.splice(i, 1);
                    i--;
                }
            }
            
            modes_index = buildFilesModesIndex(files);
            // move stripped folder to destination
            ncp(fromDir, destination, function (err) {
                if (err) {
                    done.reject();
                } else {
                    rimraf(fromDir, function(){
                        done.resolve({files: files, index: modes_index});
                    });
                }
            });
        } else {
            modes_index = buildFilesModesIndex(files);
            done.resolve({files: files, index: modes_index});
        }

        return done.promise;
    }
};
function buildFilesModesIndex (files) {
    var index = {};
    for (var i = 0; i < files.length; i++) {
        index[ files[i].path ] = files[i].mode;
    }
    return index;
}