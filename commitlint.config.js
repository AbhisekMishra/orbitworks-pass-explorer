export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['api', 'web', 'shared', 'harness', 'ci', 'docker', 'docs', 'deps', 'e2e', 'repo'],
    ],
    'body-max-line-length': [0],
  },
};
