import fs from "node:fs";
import crypto from "node:crypto";
import https from "node:https";

const SPACE_ID = "mp-5dcb9f9e-a8e8-4d51-a064-e30f76421e0a";
const SECRET   = "bXt46OTsd+sQiENPhLf7Vg==";
const ENDPOINT = "https://api.next.bspapp.com/client";
const URL_CODE = process.env.URL_CODE || "SLPC5S";
const PAGE_SIZE = 50;

function sign(data) {
  let n = "";
  Object.keys(data).sort().forEach((k) => { if (data[k]) n += "&" + k + "=" + data[k]; });
  n = n.slice(1);
  return crypto.createHmac("md5", SECRET).update(n).digest("hex");
}

function post(body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(ENDPOINT, {
      method: "POST",
      timeout: 20000,
      headers: Object.assign({
        "Content-Type": "application/json",
        "x-serverless-sign": sign(body),
        "Content-Length": Buffer.byteLength(data),
        "Connection": "close",
      }, extraHeaders),
    }, (res) => {
      let raw = "";
      res.on("data", (d) => (raw += d));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) {}
        if (!parsed || !parsed.success) {
          const err = (parsed && parsed.error) || {};
          reject(new Error(err.message || err.code || "request failed"));
          return;
        }
        resolve(parsed.data);
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; console.log("retry", i + 1, "after:", e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
  throw last;
}

async function getToken() {
  const body = { spaceId: SPACE_ID, timestamp: Date.now(), method: "serverless.auth.user.anonymousAuthorize", params: "{}" };
  const data = await post(body);
  return data.accessToken;
}

async function callFunction(functionTarget, functionArgs, token) {
  const body = {
    method: "serverless.function.runtime.invoke",
    params: JSON.stringify({ functionTarget, functionArgs: functionArgs || {} }),
    spaceId: SPACE_ID, timestamp: Date.now(), token,
  };
  return post(body, { "x-basement-token": token });
}

async function queryCollection(collection, stages, token) {
  const command = { $db: [{ $method: "collection", $param: [collection] }].concat(stages) };
  const data = await callFunction("DCloud-clientDB", { command }, token);
  if (data && data.code !== 0) throw new Error(data.message || "query failed");
  return data;
}

function buildWhere(box, now) {
  let cutoff = now - 31536e7;
  if (box.range) {
    const days = Number(box.range);
    if (days > 0 && days <= 180) cutoff = now - days * 864e5;
  }
  return `user_id=='${box.user_id}'&&is_public_reply==true&&status==1&&create_time>${cutoff}`;
}

async function main() {
  const token = await withRetry(() => getToken());
  console.log("token ok");

  const boxData = await withRetry(() => queryCollection("ask_box_info", [
    { $method: "where", $param: [{ $db: [{ $method: "command" }, { $method: "or", $param: [[{ default_url_code: URL_CODE }, { custom_url_code: URL_CODE }]] }] }] },
    { $method: "get", $param: [] },
  ], token));
  const box = boxData.data[0];
  if (!box) throw new Error("box not found: " + URL_CODE);
  console.log("box ok:", box.user_id);

  const user = await withRetry(() => callFunction("box_web", { user_id: box.user_id, type: "get_user_info" }, token));
  console.log("user ok:", user.user_name);

  let pinned = [];
  if (box.pin_to_top && box.pin_to_top.length) {
    const p = await withRetry(() => callFunction("box_web", { type: "get_pin_to_top", other_data: { pin_to_top: box.pin_to_top } }, token));
    pinned = Array.isArray(p) ? p : (p && p.data ? p.data : []);
  }
  console.log("pinned ok:", pinned.length);

  const now = Date.now();
  const questions = [];
  let page = 1, total = Infinity;
  while (questions.length < total && page <= 40) {
    const res = await withRetry(() => queryCollection("ask_box_question", [
      { $method: "where", $param: [buildWhere(box, now)] },
      { $method: "field", $param: ["question,create_time,chat_list,update_time"] },
      { $method: "orderBy", $param: ["update_time desc"] },
      { $method: "skip", $param: [(page - 1) * PAGE_SIZE] },
      { $method: "limit", $param: [PAGE_SIZE] },
      { $method: "get", $param: [{ getCount: true }] },
    ], token));
    total = res.count != null ? res.count : res.data.length;
    questions.push(...res.data);
    page++;
    console.log("questions page", page - 1, "fetched, total", total);
  }

  const fileIds = [];
  for (const q of questions) {
    for (const m of (q.chat_list || [])) {
      if (m.file_id && m.file_id !== "") fileIds.push(m.file_id);
    }
  }
  const uniqFileIds = fileIds.filter((v, i) => fileIds.indexOf(v) === i);
  const files = {};
  if (uniqFileIds.length) {
    const f = await withRetry(() => queryCollection("file", [
      { $method: "where", $param: [{ _id: { $db: [{ $method: "command" }, { $method: "in", $param: [uniqFileIds] }] } }] },
      { $method: "get", $param: [] },
    ], token));
    for (const doc of f.data) files[doc._id] = doc;
    console.log("files:", Object.keys(files).length);
  }

  const out = {
    updated_at: Date.now(),
    url_code: URL_CODE,
    box,
    user,
    pinned,
    questions,
    files,
    total: questions.length,
  };
  fs.writeFileSync("data.json", JSON.stringify(out, null, 2));
  console.log("synced", questions.length, "questions, pinned", pinned.length, "files", Object.keys(files).length, "total", out.total);
}

main().catch((e) => { console.error("SYNC FAILED:", e.message); process.exit(1); });


