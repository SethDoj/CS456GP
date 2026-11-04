
/**
 * MAXIMUM dropped requsts is (DROPPED_REQUEST_WINDOW-(SLOW_REQUEST_TIME+SLOW_REQUEST_WINDOW)) / ping rate
 * Slow requests has the same constraignts with SLOW REQUEST TIME + WINDOW / ping
 */
export const HeartbeatConfig = {
    PORT: 5000,
    //how many slow/dropped requests until errored
    SLOW_BUCKET_LIMIT: 3,
    //slow requests are considered dropped after 2200 ms, if more than ten occur in this window we will promote.
    SLOW_BUILDUP_WINDOW: 30000,
    DROPPED_REQUEST_LIMIT: 2,
    DROPPED_REQUEST_WINDOW: 6000,
    //ms
    //this sets how long a request needs to take be "slow"
    SLOW_REQUEST_TIME: 200,
    //After which a request will be considered dropped
    SLOW_REQUEST_WINDOW: 3000

} as const
