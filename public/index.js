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

let rows;
regenerateGrid();

function regenerateGrid() {
  rows = [];
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
        allAdjacent(cell).forEach(adj_cell => cell.number += (adj_cell.is_bomb ? 1 : 0));
}

function allAdjacent(cell) {
  let adj_cells = [];
  for (let dy of [-1, 0, 1]) {
    for (let dx of [-1, 0, 1]) {
      // don't include the cell itself
      if (dy == 0 && dx == 0)
        continue;

      if (rows[cell.y + dy]?.[cell.x + dx])
        adj_cells.push(rows[cell.y + dy][cell.x + dx]);
    }
  }
  return adj_cells;
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

let is_first_click = true;
document.addEventListener('click', function(evt) {
  let td;
  if (evt.target.tagName == 'I')
    td = evt.target.parentNode;
  else if (evt.target.tagName == 'TD')
    td = evt.target;

  if (!td)
    return;

  let x = td.cellIndex;
  let y = td.parentNode.rowIndex;

  // for the first click, guarantee that it's a space with no bomb or number
  // so we can flood-fill
  if (is_first_click) {
    while (rows[y][x].is_bomb || rows[y][x].number)
      regenerateGrid();
    is_first_click = false;
  }
  
  let cell = rows[y][x];
  onClick(cell, evt.shiftKey);
});

function onClick(cell, is_shift_down) {
  if (is_shift_down) {
    cell.is_flag = !cell.is_flag;
  }
  else if (cell.is_visible && cell.number) {
    let adj_cells = allAdjacent(cell);
    let num_adj_flagged = adj_cells.filter(cell => cell.is_flag).length;
    
    // if the user clicks on a number that has all bombs flagged
    // then auto-click all invisible adjacent cells
    if (num_adj_flagged == cell.number)
      adj_cells.filter(cell => !cell.is_visible).forEach(cell => onClick(cell));
  }
  else {
    floodFill(cell);
  }

  renderTable();
}

function floodFill(cell) {
  if (!cell.is_visible) {
    cell.is_visible = true;
    if (!cell.is_bomb && !cell.number)
      allAdjacent(cell).forEach(floodFill);
  }
}