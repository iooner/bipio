#!/usr/bin/env node
/**
 *
 * The Bipio API Server
 *
 * @author Michael Pearson <michael@cloudspark.com.au>
 * Copyright (c) 2010-2013 CloudSpark pty ltd http://www.cloudspark.com.au
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * A Bipio Commercial OEM License may be obtained via enquiries@cloudspark.com.au
 */
/**
 * REST API Server bootstrap 
 */
var bootstrap = require(__dirname + '/bootstrap'),
app = bootstrap.app,
cluster = require('cluster'),
express = require('express'),
session = require('express-session'),
cookieParser = require('cookie-parser'),
bodyParser = require('body-parser'),
jsonp = require('json-middleware'),
methodOverride = require('method-override'),
helper  = require('./lib/helper'),
passport = require('passport'),
cron = require('cron'),
restapi = express();
MongoStore = require('connect-mongo')({ session : session});
connectUtils = require(__dirname + '/../node_modules/connect/lib/utils.js');

/**
 * express bodyparser looks broken or too strict.
 */
function xmlBodyParser(req, res, next) {
  var enc = connectUtils.mime(req);
  if (req._body) return next();
  req.body = req.body || {};

  // ignore GET
  if ('GET' == req.method || 'HEAD' == req.method) return next();

  // check Content-Type
  if (!/xml/.test(enc)) {
    return next();
  }

  // flag as parsed
  req._body = true;

  // parse
  var buf = '';
  req.setEncoding('utf8');
  req.rawBody = '';

  req.on('data', function(chunk) {
    req.rawBody += chunk;
  });
  req.on('end', function(){
    next();
  });
}

function errorHandler(err, req, res, next) {
  res.status(500);
  res.render('error', { error: err });
}

function setCORS(req, res, next) {
  res.header('Access-Control-Allow-Origin', req.headers.origin);
  res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.header('Access-Control-Allow-Methods', req.headers['access-control-request-method'] || 'GET,POST,PUT,DELETE');
  res.header('Access-Control-Allow-Credentials', true);

  next();
}

// express preflights

restapi.use(xmlBodyParser);

// respond with an error if body parser failed
restapi.use(function(err, req, res, next) {
  console.log(err);
  if (err.status == 400) {
    restapi.logmessage(err, 'error');
    res.send(err.status, {
      message : 'Invalid JSON. ' + err
    });
  } else {
    next(err, req, res, next);
  }
});

restapi.use(bodyParser());
restapi.use(setCORS);
restapi.use(methodOverride());
restapi.use(cookieParser());

// required for some oauth provders

restapi.use(session({
  key : 'sid',
  cookie: {
    maxAge: 60 * 60 * 1000,
    httpOnly : true
  },
  secret: GLOBAL.CFG.server.sessionSecret,
  store: new MongoStore({      
    mongoose_connection : app.dao.getConnection()
  })
}));

restapi.use(passport.initialize());
restapi.use(passport.session());
restapi.use(jsonp.middleware());
restapi.disable('x-powered-by');

// export app everywhere
module.exports.app = app;

app.isMaster = cluster.isMaster;

if (cluster.isMaster) {
  // when user hasn't explicitly configured a cluster size, use 1 process per cpu
  var forks = GLOBAL.CFG.server.forks ? GLOBAL.CFG.server.forks : require('os').cpus().length;
  app.logmessage('BIPIO:STARTED:' + new Date());
  app.logmessage('Node v' + process.versions.node);
  app.logmessage('Starting ' + forks + ' fork(s)');

  for (var i = 0; i < forks; i++) {
    var worker = cluster.fork();
  }

  app.dao.on('ready', function(dao) {
    var crons = GLOBAL.CFG.crons;

    // Network chords and stats summaries
    if (crons && crons.stat && '' !== crons.stat) {
      app.logmessage('DAO:Starting Stats Cron', 'info');
      var statsJob = new cron.CronJob(crons.stat, function() {
        dao.generateHubStats(function(err, msg) {
          if (err) {
            app.logmessage('STATS:THERE WERE ERRORS');
          } else {
            app.logmessage(msg);
            app.logmessage('STATS:DONE');
          }
        });
      }, null, true, GLOBAL.CFG.timezone);
    }

    // periodic triggers
    if (crons && crons.trigger && '' !== crons.trigger) {
      app.logmessage('DAO:Starting Trigger Cron', 'info');
      var triggerJob = new cron.CronJob(crons.trigger, function() {
        dao.triggerAll(function(err, msg) {
          if (err) {
            app.logmessage('TRIGGER:' + err + ' ' + msg);
          } else {
            app.logmessage(msg);
            app.logmessage('TRIGGER:DONE');
          }
        });
      }, null, true, GLOBAL.CFG.timezone);
    }

    // auto-expires
    if (crons && crons.expire && '' !== crons.expire) {
      app.logmessage('DAO:Starting Expiry Cron', 'info');
      var expireJob = new cron.CronJob(crons.expire, function() {
        dao.expireAll(function(err, msg) {
          if (err) {
              app.logmessage('EXPIRE:ERROR:' + err);
              app.logmessage(msg);
          } else {
              app.logmessage('EXPIRE:DONE');
          }
        });
      }, null, true, GLOBAL.CFG.timezone);
    }

    // oAuth refresh
    app.logmessage('DAO:Starting OAuth Refresh', 'info');
    var oauthRefreshJob = new cron.CronJob('0 */15 * * * *', function() {
      dao.refreshOAuth();
    }, null, true, GLOBAL.CFG.timezone);   
  });

  cluster.on('disconnect', function(worker) {
    app.logmessage('Worker ' + worker.id + ' dropped.  Respawning.', 'error');
    cluster.fork();
  });

} else {
  var domain = require('domain');
  
  workerId = cluster.worker.workerID;
  app.logmessage('BIPIO:STARTED:' + new Date());
  helper.tldtools.init(
    function() {
      app.logmessage('TLD:UP');
    },
    function(body) {
      app.logmessage('TLD:Cache fail - ' + body, 'error')
    }
  );

  app.dao.on('ready', function(dao) {
    var d = domain.create();
    d.on('error', function(er) {
      var killtimer = setTimeout(function() {
        process.exit(1);
      }, 10000);
      
      killtimer.unref();
      
      restapi.close();
      cluster.worker.disconnect();
    });
    
    require('./router').init(restapi, dao);
    
    restapi.listen(GLOBAL.CFG.server.port, GLOBAL.CFG.server.host, function() {
      app.logmessage('Listening on :' + GLOBAL.CFG.server.port + ' in "' + restapi.settings.env + '" mode...');
      restapi.use(errorHandler);      
    });
  });
}
