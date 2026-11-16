import { validateOptions } from '../generation/catalog.mjs';
import { send } from './response.mjs';

export function createGenerationRoutes({ jobs, check, desktop }) {
  function get(res, url) {
    const reply = (status, value) => { send(res, status, value); return true; };
    if (url.pathname === '/api/jobs') return reply(200, jobs.list());
    if (url.pathname.startsWith('/api/jobs/')) {
      const job = jobs.view(url.pathname.slice('/api/jobs/'.length));
      return reply(job ? 200 : 404, job ?? { error: '找不到这个创建任务。' });
    }
    return false;
  }

  async function post(res, url, payload) {
    if (url.pathname.endsWith('/open')) {
      const id = url.pathname.split('/')[3];
      if (!jobs.view(id)) return send(res, 404, { error: '找不到这个创建任务。' });
      try {
        await jobs.openProject(id, payload.action, (...args) => desktop.openProject(...args));
        return send(res, 200, { requested: true });
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    if (/\/(publish|retry|cancel)$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      try {
        if (url.pathname.endsWith('/cancel')) await jobs.cancel(id);
        else await jobs.retry(id, url.pathname.endsWith('/publish'));
        return send(res, 202, { id });
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    let input;
    try { input = validateOptions(payload); }
    catch (error) { return send(res, 400, { error: error.message }); }
    if (url.pathname === '/api/checks') return send(res, 200, await check(input));
    try { return send(res, 202, { id: await jobs.create(input) }); }
    catch (error) { return send(res, 409, { error: error.message }); }
  }

  return { get, post };
}
