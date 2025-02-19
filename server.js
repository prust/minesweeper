// set up logging & uncaught error handlers first, in order to catch & log startup errors
// TODO: manually delete old log files or do a pull request to make it part of pino-roll
// the maintainer would merge it, see: https://github.com/mcollina/pino-roll/issues/8#issuecomment-2047144242
import pino from 'pino';
let logger = pino({level: 'debug', timestamp: pino.stdTimeFunctions.isoTime, redact: ['token_hash', 'hash']}, pino.transport({
  targets: [
    {target: 'pino-roll', level: 'debug', options: {file: 'logs/combined', frequency: 'daily', dateFormat: 'yyyy-MM-dd', extension: '.log', mkdir: true }},
    {target: 'pino-roll', level: 'info', options: {file: 'logs/error', frequency: 'daily', dateFormat: 'yyyy-MM-dd', extension: '.log', mkdir: true }},
    {target: 'pino/file', level: 'debug', options: { destination: 1 }}, // dest 1 writes to STDOUT
  ]
}));

logger.info('Minesweeper server starting up');

// set up uncaught error handling early, so we can log startup errors
process.on('uncaughtException', exitHandler(1, 'Unexpected Error'));
process.on('unhandledRejection', exitHandler(1, 'Unhandled Promise'));
process.on('SIGTERM', exitHandler(0, 'SIGTERM'));
process.on('SIGINT', exitHandler(0, 'SIGINT'));

// node imports
import assert from 'node:assert';
import fs from 'node:fs';
import { access, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';

// library imports
import express from 'express';
import { WebSocketServer } from 'ws';
import 'dotenv/config';

// internal & vendored imports
import _ from './public/vendor/underscore-esm-1.13.7.mjs';

// import.meta.dirname is only defined in Node 20+
let __dirname = import.meta.dirname || path.dirname(process.argv[1]);

let port = process.env.PORT || 8080;
let base_url = process.env.BASE_URL || `http://localhost:${port}`;

let meta_json = fs.readFileSync('public/metadata.json', { encoding: 'utf8' });
let { entities, core_properties, page_delta, types, states } = JSON.parse(meta_json);

let app = express();
app.use(express.json());

// publicly accessible static resources
// avoid serving index.html so that it requires auth & redirects unauthed hits
app.use(express.static('public', {index: false}));

// override Express's default error handler
app.use(function(err, req, res, next) {
  logger.error(err);
  
  res.status(500);
  let err_message = err.message;
  if (err.code)
    err_message += ` (${err.code})`;

  // for better security, don't send the stack to the client
  if (req.accepts('json'))
    res.json(_.pick(err, 'message', 'code'));
  else if (req.accepts('html'))
    res.send(`<!doctype html><html><body>${err_message}</body></html>`);
  else
    res.send(err_message);
});

let server = app.listen(port, function() {
  logger.info(`Minesweeper listening on port ${port}`);
});

// no need for clientTracking, since we're setting req.user during our auth
// this code is based on https://github.com/websockets/ws/blob/master/examples/express-session-parse/index.js
// and on https://github.com/websockets/ws?tab=readme-ov-file#client-authentication
let wss = new WebSocketServer({ clientTracking: false, noServer: true });

server.on('upgrade', async function(req, socket, head) {
  socket.on('error', onSocketError);
  function onSocketError(err) {
    logger.error(err, 'onSocketError');
  }

  console.log('Parsing session from request...');

  try {
    req.user = await authenticate(req);
  }
  catch(err) {
    logger.error(err, 'websocket auth error');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // I *think* this is removed b/c subsequent errors will be handled by ws.on('error')
  socket.removeListener('error', onSocketError);

  wss.handleUpgrade(req, socket, head, function(ws) {
    wss.emit('connection', ws, req);
  });
});

let curr_connections = {};
let ws_handlers = {};
let next_conn_id = 1;
wss.on('connection', function(ws, req) {
  let conn_id = next_conn_id++;
  let user = req.user;
  let hostname = req.headers.host;

  curr_connections[conn_id] = {ws, user_id: user.id};
  
  ws.on('error', function(err) {
    logger.error(err, `websocket error for user ${user.id}`);
  });

  ws.on('message', async function(msg) {
    // super-fast & simple ping/pong to keep the connection open
    // & help the client detect disconnects
    if (msg == 'ping')
      return ws.send('pong');

    try {
      msg = JSON.parse(msg);
    }
    catch(err) {
      return logger.error(err, `failed to parse ws message from ${user.id}: ${msg.slice(0, 250)}`);
    }

    let handler = ws_handlers[msg.route];
    if (!handler)
      return logger.warn(`No handler for route "%s" from user %d (%o)`, msg.route, user.id, msg);

    msg.hostname = hostname;
    msg.user = user;
    let data;
    try {
      data = await handler(msg);
    }
    catch(err) {
      // TODO: check if err is handled/known/expected
      logger.error(err, 'ws handler error');
      return ws.send(JSON.stringify({success: false, err: {message: err.message}}));
    }

    // sometimes handlers need to return wrapper data (offset, total, etc)
    // in addition to the main data
    // if they return an object with a data property, that's the case
    // otherwise (by default) they just return the main data
    let res = {id: msg.id, route: msg.route};
    if (typeof data == 'object' && data.data) {
      Object.assign(res, data);
    }
    else {
      res.data = data;
    }

    // reflect the message route & id back
    ws.send(JSON.stringify(res));
  });

  ws.on('close', function() {
    delete curr_connections[conn_id];
  });
});

app.get('/', (req, res) => res.sendFile('public/index.html', {root: '.'}));

// update an entity (or some properties of an entity)
entities.forEach(function(ent) {
  // internal entities (like tokens) don't have CRUD API routes
  if (ent.is_internal)
    return;

  let ent_id = ent.id;
  let properties = ent.is_join || ent.is_internal ? ent.properties : ent.properties.concat(core_properties);
  let prop_names = _.pluck(properties, 'name');

  if (ent.is_join) {
    // update join record based on both IDs
    let ids = ent_id.split('_').map(ent => `${ent}_id`);
    ws_handlers[`PUT /entity/${ent_id}`] = async function(msg) {
      let supplied_props = Object.keys(msg.data);
      let unknown_props = _.difference(supplied_props, prop_names);
      if (unknown_props.length)
        throw new Error(`Unknown properties for ${ent_id}: ${unknown_props}`);

      let missing_id_props = _.difference(ids, supplied_props);
      if (missing_id_props.length)
        throw new Error(`Missing necessary ID(s) for ${ent_id}: ${missing_id_props}`);
      
      let props_to_update = _.difference(supplied_props, ids);

      let sql = `UPDATE ${ent_id} SET `;
      let values = {};
      sql += props_to_update.map(function(prop_name) {
        values[prop_name] = msg.data[prop_name];
        return `${prop_name}=$${prop_name}`;
      }).join(', ');

      sql += ` WHERE `;
      sql += ids.map(function(id_name) {
        values[id_name] = msg.data[id_name];
        return `${id_name}=$${id_name}`;
      }).join(' AND ');

      await query(msg, sql, values);

      if (ent_id.startsWith('task_'))
        for (let prop_name of props_to_update)
          recordChange(msg, 'update', ent_id, msg.data[ids[1]], msg.data.task_id, prop_name, msg.data[prop_name]);
      
      return {success: true};
    };
  }
  else {
    // update entity based on ID
    ws_handlers[`PUT /entity/${ent_id}`] = async function(msg) {
      let supplied_props = Object.keys(msg.data);
      let unknown_props = _.difference(supplied_props, prop_names);
      if (unknown_props.length)
        throw new Error(`Unknown properties for ${ent_id}: ${unknown_props}`);

      let {state} = msg.data;
      let prev_state;
      if (ent_id == 'task' && state) {
        // prev_state is used for auto-task moving (below) and determining if accept_date needs to be set
        prev_state = (await query(msg, `SELECT state FROM ${ent_id} WHERE id=$item_id`, msg))[0]?.state;

        if (state == '_accepted' && prev_state != '_accepted') {
          msg.data.accept_date = new Date().toISOString();
          supplied_props.push('accept_date');
        }
      }

      let sql = `UPDATE ${ent_id} SET `;
      let values = {};
      sql += supplied_props.map(function(prop_name) {
        values[prop_name] = msg.data[prop_name];
        return `${prop_name}=$${prop_name}`;
      }).join(', ');

      sql += ` WHERE id=$item_id`;
      values.item_id = msg.item_id;
      await query(msg, sql, values);

      onEntityUpdate(msg, ent_id, msg.item_id, msg.data);

      // only auto-move task on Accept or on the transtion from unstarted to WIP (Work In Progress)
      // to avoid surprising the user and moving the task somewhere they don't expect
      if (ent_id == 'task' && state && state != prev_state) {
        let task_id = msg.item_id;
        let non_wip = ['_unstarted', '_unscheduled']; // not Work In Progress
        if (state == '_accepted' || (in_progress_states.includes(state) && non_wip.includes(prev_state))) {
          let project_positions = await query(msg, `SELECT project_id, position FROM task_project WHERE task_id=$item_id`, msg);
          for (let {project_id, position} of project_positions) {
            let new_msg = Object.assign({}, msg, {data: {project_id, task_id, already_in_proj: true, pos_for_state: state, from_pos: position}});
            await ws_handlers['PUT /task/position'](new_msg);
          }
        }
      }

      return { success: true };
    };
  }

  // create a new instance of an entity
  ws_handlers[`POST /entity/${ent_id}`] = async function(msg) {
    let supplied_props = Object.keys(msg.data);
    let unknown_props = _.difference(supplied_props, prop_names);
    if (unknown_props.length)
      throw new Error(`Unknown properties for ${ent_id}: ${unknown_props}`);

    let sql = `INSERT INTO ${ent_id} (${supplied_props})
      VALUES (${supplied_props.map(prop_name => `$${prop_name}`)})
      ${ent.is_join ? '' : 'RETURNING id'}`;
    
    let new_id = (await query(msg, sql, msg.data))[0]?.id;

    if (ent.is_join) {
      if (ent_id.startsWith('task_')) {
        if (ent_id == 'task_person')
          await ensureFollowing(msg, msg.data.person_id, msg.data.task_id);
        else if (ent_id == 'task_requester')
          await ensureFollowing(msg, msg.data.requester_id, msg.data.task_id);

        let other_id = ent_id.replace('task_', '') + '_id';
        recordChange(msg, 'create', ent_id, msg.data[other_id], msg.data.task_id);
      }
    }
    else if (ent_id == 'task' || ent_id in task_children) { 
      await ensureFollowing(msg, msg.user.id, ent_id == 'task' ? new_id : msg.data.task_id);

      // TODO: we should record *this* change *after* onEntityUpdate(), since that adds followers
      // but *before* the recordChanges IN onEntityUpdate(), since it's a create & happens first.
      await recordChange(msg, 'create', ent_id, new_id);
      
      // we don't want/need to record updates on id/task_id on create
      delete msg.data.id;
      delete msg.data.task_id;
      delete msg.data.create_date;
      onEntityUpdate(msg, ent_id, new_id, msg.data);
    }

    return { success: true, data: {id: new_id, ...msg.data}};
  };

  // delete a join record based on two columns
  if (ent.is_join) {
    let ids = ent_id.split('_').map(ent => `${ent}_id`);
    ws_handlers[`DELETE /entity/${ent_id}`] = async function(msg) {
      for (let id of ids)
        assert(msg[id]);

      let sql = `DELETE FROM ${ent_id} WHERE `;
      sql += ids.map(function(id_prop) {
        return `${id_prop}=$${id_prop}`;
      }).join(' AND ');
  
      await query(msg, sql, msg);

      if (ent_id.startsWith('task_')) {
        let other_id = ent_id.replace('task_', '') + '_id';
        recordChange(msg, 'delete', ent_id, msg[other_id], msg.task_id);
      }
      return {success: true};
    };
  }
  else {
    ws_handlers[`DELETE /entity/${ent_id}`] = async function(msg) {
      let delete_date = new Date().toISOString();
      await query(msg, `UPDATE ${ent_id} SET delete_date=$date WHERE id=$id`, {date: delete_date, id: msg.item_id});

      // TODO: record this as an update, not a delete
      // and make the UI display delete_date updates as deletes
      if (ent_id == 'task' || ent_id in task_children)
        recordChange(msg, 'update', ent_id, msg.item_id, null, 'delete_date', delete_date);

      return {success: true};
    };
  }
});



// helper functions

function parseChangeValues(changes) {
  for (let change of changes) {
    // TODO: try/catching in a hot/tight loop is reputed to be expensive
    // once old, non-JSON notifications are cleared or deleted, we can remove this try/catch
    try {
      change.new_value = JSON.parse(change.new_value);
    }
    catch(err) {
      logger.warn('TEMP: %s %s (%d) change new_value NOT JSON: %s', change.ent_id, change.prop_name, change.target_id, change.new_value);
    }
  }
}

async function onEntityUpdate(msg, ent_id, item_id, params) {
  // TODO: tag all props that can have rich text (usernames) in the metadata
  for (let prop_name in params) {
    if ((ent_id == 'comment' && prop_name == 'text') || prop_name == 'description')
      await ensureUsernamesFollowing(msg, ent_id, item_id, params[prop_name]);
    if (ent_id == 'blocker' && prop_name == 'description')
      await updateBlockerChildren(msg, item_id, params[prop_name]);
  }

  if (ent_id == 'task' || ent_id in task_children)
    for (let prop_name in params)
      recordChange(msg, 'update', ent_id, item_id, null, prop_name, params[prop_name]);
}

// It's tempting to also record the relevant project_ids, but that would add a lot of complexity on this end
// since the relevant project IDs are not available in the CRUD APIs above
// better to JOIN to the project. This means that if a task is removed from a project after a bunch of changes
// or added to a project after a bunch of changes, those changes will retroactively be included/excluded from the project history
// this is unintuitive, but the systemic complexity of avoiding this is a probably not worth it
// if we emphasize the adding/removing of a task from a project in the UI, that should hopefully be good enough
// Note that if a task is deleted, it will still be included in the project history (it will just have a delete_date)
// it's only if the task is removed from the project that it won't be included
async function recordChange(msg, change_type, ent_id, target_id, task_id, prop_name, new_value) {
  if (ent_id == 'task')
    task_id = target_id;

  // due to the simple per-record CRUD API, we don't have the parent task_id when a task's child record is updated
  // so we look it up via an INSERT INTO ... SELECT statement
  // we could avoid the work here, but that would result in more complexity downstream (in the `INSERT INTO notification` below & in subsequent queries)
  let sql = `INSERT INTO change (change_type, person_id, ent_id, target_id, prop_name, new_value, create_date, task_id)
    ${ ent_id in task_children ?
      // pull the task_id from the entity's table, populate everything else from named params
      `SELECT $change_type, $person_id, $ent_id, $target_id, $prop_name, $new_value, $create_date, task_id FROM ${ent_id} WHERE id=$task_id`
    :
      `VALUES ($change_type, $person_id, $ent_id, $target_id, $prop_name, $new_value, $create_date, $task_id)`
    }
    RETURNING id, task_id`;

  let create_date = new Date().toISOString();
  let values = {change_type, person_id: msg.user.id, ent_id, target_id, prop_name, new_value: JSON.stringify(new_value), create_date};
  // TODO: this is confusing, couldn't we just use $target_id
  // in the relevant SQL above instead of `values.task_id = target_id`?
  if (ent_id in task_children)
    values.task_id = target_id;
  else
    values.task_id = task_id;

  let change = (await query(msg, sql, values))[0];
  
  // at present, every tracked change should be related to a task
  assert(change.task_id);

  // create a notification for everyone who's following the task
  // EXCEPT the user who is making the change
  let {task_name, follower_ids, project_ids} = (await query(msg, `SELECT task.name AS task_name,
      array_remove(array_agg(DISTINCT follower_id), NULL) AS follower_ids,
      array_remove(array_agg(DISTINCT project_id), NULL) AS project_ids
    FROM task
    LEFT JOIN task_follower ON task_follower.task_id = task.id
    INNER JOIN task_project ON task_project.task_id = task.id
    WHERE task.id = $task_id
      AND follower_id != $change_user_id
    GROUP BY task.name`, {task_id: change.task_id, change_user_id: msg.user.id}))[0] || {};
    
  let rows = [];
  if (follower_ids?.length) {
    rows = await query(msg, `INSERT INTO notification (change_id, person_id, is_read) VALUES
      ${follower_ids.map(follower_id => `($change_id, ${follower_id}, false)`).join(', ')}
      RETURNING id, person_id`,
      {change_id: change.id});
  }
  let follower_id_to_notification_id = Object.fromEntries(rows.map(row => [row.person_id, row.id]));

  let change_msg = {type: 'change', change_type, ent_id, target_id, task_id: change.task_id, prop_name, new_value};

  // if the change is on a TaskPane filterable property
  // query other filterable properties & send them with the change event
  // so clients can know if the associated task should now be included, due to matching the filters
  let is_filterable_change = ['task_project', 'task_tag', 'task_person'].includes(ent_id) ||
    (ent_id == 'task' && prop_name == 'state') ||
    // blockers need to by dynamically added to My Work if the description changes to include me or if it's unresolved or if it's undeleted
    (ent_id == 'blocker' && (prop_name == 'description' || (prop_name == 'resolved' && !new_value) || (prop_name == 'delete_date' && !new_value)));
  
  // if it's a task create, get the whole shallow_task, so clients don't choke on arrays not being present
  if (is_filterable_change || (change_type == 'create' && ent_id == 'task')) {
    let res = await ws_handlers['GET /project/tasks']({task_id: change.task_id});

    // on new task creation, the task_project change is triggered before the new task is created
    // so this query doesn't return anything yet
    if (res.data[0])
      change_msg.shallow_task = res.data[0];
  }
  
  // iterate all active websockets & send change to them all
  // a notification is a superset of a change that includes some additional properties
  // for those who are following the task
  let stringified_change = JSON.stringify(change_msg);
  let notification = Object.assign(change_msg, {
    is_notification: true,
    is_read: false,
    person_id: msg.user.id,
    create_date,
    task_name: task_name || '',
    project_ids : project_ids || [],
  });

  // send change to all connected users
  // send notification to all connected followers
  for (let conn_id in curr_connections) {
    let {ws, user_id} = curr_connections[conn_id];

    let msg;
    if (follower_ids?.includes(user_id)) {
      let notification_id = follower_id_to_notification_id[user_id];
      Object.assign(notification, {notification_id});
      msg = JSON.stringify(notification);
    }
    else {
      msg = stringified_change;
    }
    ws.send(msg);
  }
}

// from https://blog.heroku.com/best-practices-nodejs-errors
function exitHandler(code, reason) {
  let timeout = 500;
  let coredump = false;

  function exit() {
    if (coredump)
      process.abort();
    else
      process.exit(code);
  }

  return function(err) {
    if (err && err instanceof Error) {
      // acc'd to https://getpino.io/#/docs/api?id=pino-destination:
      // > The transport() function adds a listener to process.on('beforeExit') and process.on('exit')
      // > to ensure the worker is flushed and all data synced before the process exits.
      // so this should be all that we need to do to ensure the logs are properly flushed on crash
      err.message = `${reason}: ${err.message}`;
      logger.fatal(err);
    }

    // Attempt a graceful shutdown
    if (typeof server != 'undefined') {
      server.close(exit);
      setTimeout(exit, timeout).unref();
    }
    else {
      exit();
    }
  };
}