const http = require("http");
function post(secret, label) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ event_id: "", event_name: "page_view", client_id: "1724072241.1781603938", trigger_from: "", user_id: "" });
    const req = http.request({
      host: "127.0.0.1", port: 8095, path: "/api/v1/collect/wh_powertokens_001",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pt-webhook-secret": secret }
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(`${label} -> ${res.statusCode} ${body}`));
    });
    req.on("error", (e) => resolve(`${label} -> ERROR ${e.message}`));
    req.write(data);
    req.end();
  });
}
(async () => {
  console.log(await post("b376a8359e51cd4d5d3f1808f5df04d51a123fa76379642ce20725a5b5365d58", "A 正确secret+page_view空event_id"));
  console.log(await post("wrongsecret", "B 错误secret"));
})();
