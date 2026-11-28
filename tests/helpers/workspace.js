"use strict";

const fs = require("node:fs");
const path = require("node:path");

const API_ROOT = path.resolve(__dirname, "../..");
const SIBLING_ROOT = path.resolve(API_ROOT, "..");

function configuredDirectory(environmentName, siblingName) {
  const configured = String(process.env[environmentName] || "").trim();
  if (configured) {
    const resolved = path.resolve(configured);
    return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : null;
  }
  if (!siblingName) return null;
  const sibling = path.join(SIBLING_ROOT, siblingName);
  return fs.existsSync(sibling) && fs.statSync(sibling).isDirectory() ? sibling : null;
}

function configuredFile(directoryName, siblingDirectory, filename) {
  const directory = configuredDirectory(directoryName, siblingDirectory);
  if (!directory) return null;
  const file = path.join(directory, filename);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function apiFile(...segments) {
  const override = String(process.env.ALBKHR_API_DIR || "").trim();
  const root = override ? path.resolve(override) : API_ROOT;
  const file = path.join(root, ...segments);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function requiredExternalFiles(items) {
  return items.every((item) => Boolean(item));
}

module.exports = {
  API_ROOT,
  configuredDirectory,
  configuredFile,
  apiFile,
  requiredExternalFiles
};
