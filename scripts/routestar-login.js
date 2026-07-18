'use strict';
const { RouteStarService } = require('../src/automation/routestar');

(async () => {
  const svc = new RouteStarService();
  const t0 = Date.now();
  console.log('== RouteStar login smoke test ==');
  console.log(`base URL : ${svc.session.config.baseUrl}`);
  console.log(`user     : ${svc.session.config.credentials.username || '(missing!)'}`);
  console.log(`headless : ${svc.session.config.browser.headless}`);
  try {
    await svc.open();
    await svc.session.screenshot('login-success');
    console.log(`\nLOGIN OK (${((Date.now() - t0) / 1000).toFixed(1)}s) -> ${svc.session.page.url()}`);
  } catch (e) {
    console.error(`\nLOGIN FAILED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await svc.close();
  }
})();
