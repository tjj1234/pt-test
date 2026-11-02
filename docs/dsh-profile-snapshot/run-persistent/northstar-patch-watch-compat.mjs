export default (ctx) => {
  ctx.provide('hmr', {
    async registerConfig(filename) {
      if (typeof filename !== 'string' || !filename) throw new TypeError('patch filename is required');
      return async () => {};
    },
  });
};
