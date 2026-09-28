import { bootstrap, JobQueueService } from '@vendure/core';
import { config } from './vendure-config';

bootstrap(config)
  .then(app => app.get(JobQueueService).start())
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
