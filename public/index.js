import _ from 'underscore';
import { h, render, createRef, Component } from 'preact';
import { deepSignal as observable } from "deepsignal";
import htm from 'htm';
let html = htm.bind(h);

import {assert, $, $$, defer} from '/utils.js';

let querySelectorAll = document.querySelectorAll.bind(document);

let num_rows = 30;
let num_cols = 30;
let num_mines = 190;

let rows = [];
for (let y = 0; y < num_rows; y++) {
  let row = [];
  for (let x = 0; x < num_cols; x++) {
    row.push({
      x: x,
      y: y,
      is_bomb: false,
      is_flag: false,
      number: 0,
      is_visible: false
    });
  }
  rows.push(row);
}

// place mines
let num_placed_mines = 0;
while (num_placed_mines < num_mines) {
  let y = _.random(rows.length - 1);
  let row = rows[y];
  let x = _.random(row.length - 1);
  if (!row[x].is_bomb) {
    row[x].is_bomb = true;
    num_placed_mines++;
  }
}

// set numbers
for (let row of rows)
  for (let cell of row)
    if (!cell.is_bomb)
      forEachAdjacent(cell, adj_cell => cell.number += (adj_cell.is_bomb ? 1 : 0));

function forEachAdjacent(cell, fn) {
  for (let dy of [-1, 0, 1]) {
    for (let dx of [-1, 0, 1]) {
      if (rows[cell.y + dy]?.[cell.x + dx])
        fn(rows[cell.y + dy]?.[cell.x + dx]);
    }
  }
}

app = window.app = observable({workspace: null});

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', onLoad);
else
  onLoad();

async function onLoad() {
  renderTable();
}

function renderTable() {
  render(html`<table>
    ${rows.map(function(row) {
      return html`
        <tr>
          ${row.map(function(cell) {
            if (cell.is_flag)
              return html`<td class="hidden"><i class="fa-solid fa-flag"></i></td>`;
            else if (!cell.is_visible)
              return html`<td class="hidden"></td>`;
            else if (cell.is_bomb)
              return html`<td><i class="fa-solid fa-bomb"></i></td>`;
            else if (cell.number)
              return html`<td>${cell.number}</td>`;
            else
              return html`<td> </td>`;
          })}
        </tr>`;
    })}
    </table>`, $('content'));
}

document.addEventListener('click', function(evt) {
  if (evt.target.tagName == 'TD') {
    let x = evt.target.cellIndex;
    let y = evt.target.parentNode.rowIndex;
    let cell = rows[y][x];

    if (evt.shiftKey) {
      cell.is_flag = true;
    }
    else {
      floodFill(cell);
    }

    renderTable();
    
  }
})

function floodFill(cell) {
  if (!cell.is_visible) {
    cell.is_visible = true;
    if (!cell.is_bomb && !cell.number)
      forEachAdjacent(cell, floodFill);
  }
}