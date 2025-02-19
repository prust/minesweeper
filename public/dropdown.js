import _ from 'underscore';

import { h, createRef, Component } from 'preact';
import { deepSignal as observable } from "deepsignal";
import htm from 'htm';
let html = htm.bind(h);

import {getEventHandlers, propsGetterSetters} from '/utils.js';

export default class Dropdown extends Component {
  constructor(props) {
    super(props);
    propsGetterSetters(this, 'tag_name', 'items', 'selected_ids', 'display_prop', 'children', 'onClick');
    this._state = observable({is_open: false});
    this.ref = createRef();
    _.bindAll(this, ...getEventHandlers(this));
  }

  render() {
    return html`<${this.tag_name} ref=${this.ref} class="dropdown" onClick=${() => this._state.is_open = !this._state.is_open}>
      ${this.children} <i class="bi-caret-down-fill"></i>
      ${this._state.is_open ?
        html`<ul class="dropdown-target">${
          this.items.map(item => html`<li class="${this.selected_ids.includes(item.id) ? 'selected' : ''}" onClick=${() => this.onClick(item)}>${item[this.display_prop]}</li>`)
        }</ul>`
        :
        ''
      }
    </${this.tag_name}>`;
  }

  componentDidMount() {
    document.addEventListener('click', this.onDocClick);
  }
  componentWillUnmount() {
    document.removeEventListener('click', this.onDocClick);
  }

  // close the menu on clicks elsewhere in the doc
  onDocClick(evt) {
    if (this._state.is_open && this.ref.current && !this.ref.current.contains(evt.target))
      this._state.is_open = false;
  }
}
