/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et: */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Jetpack Packages.
 *
 * The Initial Developer of the Original Code is Nickolay Ponomarev.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Nickolay Ponomarev <asqueella@gmail.com> (Original Author)
 *   Irakli Gozalishvili <gozala@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
"use strict";

const observers = require("observer-service");
const { Worker, Loader } = require('content');
const { EventEmitter } = require('events');
const { List } = require('list');
const { Registry } = require('utils/registry');

const ON_CONTENT = 'content-document-global-created',
      ON_READY = 'DOMContentLoaded',

      ERR_INCLUDE = 'The PageMod must have a string or array `include` option.';
// rules registry
const RULES = {};

const Rules = EventEmitter.resolve({ toString: null }).compose(List, {
  add: function() Array.slice(arguments).forEach(function onAdd(rule) {
    if (this._has(rule)) return;
    // registering rule to the rules registry
    if (!(rule in RULES))
      RULES[rule] = URLRule(rule);
    this._add(rule);
    this._emit('add', rule);
  }.bind(this)),
  remove: function() Array.slice(arguments).forEach(function onRemove(rule) {
    if (!this._has(rule)) return;
    this._remove(rule);
    this._emit('remove', rule);
  }.bind(this)),
});

/**
 * PageMod constructor (exported below).
 * @constructor
 */
const PageMod = Loader.compose(EventEmitter, {
  on: EventEmitter.required,
  _listeners: EventEmitter.required,
  contentScript: Loader.required,
  contentScriptURL: Loader.required,
  contentScriptWhen: Loader.required,
  include: null,
  constructor: function PageMod(options) {
    this._onAttach = this._onAttach.bind(this);
    this._onReady = this._onReady.bind(this);
    this._onContent = this._onContent.bind(this);
    let {
      onOpen, onError, include,
      contentScript, contentScriptURL, contentScriptWhen
    } = options || {};

    if (contentScript)
      this.contentScript = contentScript;
    if (contentScriptURL)
      this.contentScriptURL = contentScriptURL;
    if (contentScriptWhen)
      this.contentScriptWhen = contentScriptWhen;
    if (onOpen)
      this.on('attach', onOpen);
    if (onError)
      this.on('error', onError);

    let rules = this.include = Rules();
    rules.on('add', this._onRuleAdd = this._onRuleAdd.bind(this));
    rules.on('remove', this._onRuleRemove = this._onRuleRemove.bind(this));
    try {
      if (Array.isArray(rules))
        rules.add.apply(null, include);
      else if (rules)
        rules.add(include);
    }
    catch(e) {
      throw new Error(ERR_INCLUDE)
    }

    this.on('error', this._onUncaughtError = this._onUncaughtError.bind(this));
  },
  _onContent: function _onContent(window) {
    if (!pageModManager.has(this))
      return; // not registered yet
    if ('ready' == this.contentScriptWhen)
      window.addEventListener(ON_READY, this._onReady , false);
    else
      this._onAttach(window);
  },
  _onReady: function _onReady(event) {
    let window = event.target.defaultView;
    window.removeEventListener(ON_READY, this._onReady, false);
    this._onAttach(window);
  },
  _onAttach: function _onAttach(window) {
    this._emit('attach', Worker({
      window: window.wrappedJSObject,
      contentScript: this.contentScript,
      contentScriptURL: this.contentScriptURL,
      onError: this._onUncaughtError
    }), this._public);
  },
  _onRuleAdd: function _onRuleAdd(url) {
    pageModManager.on(url, this._onContent);
  },
  _onRuleRemove: function _onRuleRemove(url) {
    pageModManager.off(url, this._onContent);
  },
  _onUncaughtError: function _onUncaughtError(e) {
    if (this._listeners('error').length == 1)
      console.error(e.message, e.fileName, e.lineNumber, e.stack);
  }
});
exports.PageMod = function(options) PageMod(options)
exports.PageMod.prototype = PageMod.prototype;

const PageModManager = Registry.resolve({
  constructor: '_init',
  _destructor: '_registryDestructor'
}).compose({
  constructor: function PageModRegistry(constructor) {
    this._init(PageMod);
    observers.add(
      ON_CONTENT, this._onContentWindow = this._onContentWindow.bind(this)
    );
  },
  _destructor: function _destructor() {
    observers.remove(ON_CONTENT, this._onContentWindow);
    for each (rule in RULES) {
      this._removeAllListeners(rule);
      delete RULES[rule];
    }
    this._registryDestructor();
  },
  _onContentWindow: function _onContentWindow(window) {
    let { location: { port, protocol } } = window, host;
    // exception is thrown if `hostname` is accessed on 'about:*' urls in FF 3.*
    try { host = window.location.hostname } catch(e) { }
    let href = '' + window.location;
    for (let rule in RULES) {
      let { anyWebPage, exactURL, domain, urlPrefix } = RULES[rule];
      if (
        (anyWebPage && protocol && protocol.match(/^(https?|ftp):$/)) ||
        (exactURL && exactURL == href) ||
        (
          domain && host &&
          host.lastIndexOf(domain) == host.length - domain.length
        ) ||
        (urlPrefix && href && 0 == href.indexOf(urlPrefix))
      )
        this._emit(rule, window);
    }
  },
  off: function off(topic, listener) {
    this.removeListener(topic, listener);
    if (!this._listeners(topic).length)
      delete RULES[topic];
  }
});
const pageModManager = PageModManager();


exports.add = pageModManager.add;
exports.remove = pageModManager.remove;
/**
 * Parses a string, possibly containing the wildcard character ('*') to
 * create URL-matching rule. Supported input strings with the rules they
 * create are listed below:
 *  1) * (a single asterisk) - any URL with the http(s) or ftp scheme
 *  2) *.domain.name - pages from the specified domain and all its subdomains,
 *                     regardless of their scheme.
 *  3) http://example.com/* - any URLs with the specified prefix.
 *  4) http://example.com/test - the single specified URL
 * @param url {string} a string representing a rule that matches URLs
 * @returns {object} a object representing a rule that matches URLs
 */
function URLRule(url) {
  var rule;

  var firstWildcardPosition = url.indexOf("*");
  var lastWildcardPosition = url.lastIndexOf("*");
  if (firstWildcardPosition != lastWildcardPosition) {
    throw new Error("There can be at most one '*' character in a wildcard.");
  }

  if (firstWildcardPosition == 0) {
    if (url.length == 1)
      rule = { anyWebPage: true };
    else if (url[1] != ".")
      throw new Error("Expected a *.<domain name> string, got: '" + url + "'.");
    else
      rule = { domain: url.substr(2) /* domain */ };
  }
  else {
    if (url.indexOf(":") == -1) {
      throw new Error("When not using *.example.org wildcard, the string " +
                      "supplied is expected to be either an exact URL to " +
                      "match or a URL prefix. The provided string ('" +
                      url + "') is unlikely to match any pages.");
    }

    if (firstWildcardPosition == -1) {
      rule = { exactURL: url };
    }
    else if (firstWildcardPosition == url.length - 1) {
      rule = { urlPrefix: url.substr(0, url.length - 1) };
    }
    else {
      throw new Error("The provided wildcard ('" + url + "') has a '*' in an " +
                      "unexpected position. It is expected to be the first " +
                      "or the last character in the wildcard.");
    }
  }

  return rule;
};
