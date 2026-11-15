(function () {
  var pending = new Map();
  var nextId = 1;

  window.__pcdeckResolve = function (id, status, payload) {
    var entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (status >= 200 && status < 300) {
      entry.resolve(payload);
    } else {
      var message = payload && payload.error ? payload.error : 'Request failed (' + status + ')';
      entry.reject(new Error(message));
    }
  };

  function mark(text) {
    var el = document.getElementById('live-text');
    if (el) el.textContent = text;
  }

  window.addEventListener('error', function (event) {
    mark('error: ' + String(event.message).slice(0, 40));
  });

  window.__pcdeck = {
    request: function (url, method, body) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending.set(id, { resolve: resolve, reject: reject });
        try {
          window.ipc.postMessage(
            JSON.stringify({
              id: id,
              url: url,
              method: method || 'GET',
              body: body == null ? null : body,
            })
          );
        } catch (error) {
          pending.delete(id);
          mark('no ipc: ' + String(error.message).slice(0, 30));
          reject(error);
          return;
        }
        setTimeout(function () {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error('The dashboard took too long to answer.'));
        }, 180000);
      });
    },
  };
})();
