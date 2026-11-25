#import <LocalAuthentication/LocalAuthentication.h>
#import <React/RCTBridgeModule.h>

@interface LustreDeviceAuth : NSObject <RCTBridgeModule>
@property(nonatomic, strong) LAContext *activeContext;
@end

@implementation LustreDeviceAuth

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(authenticate:(NSString *)reason
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.activeContext != nil) {
      reject(@"AUTH_BUSY", @"Device authentication is already in progress.", nil);
      return;
    }

    LAContext *context = [LAContext new];
    context.touchIDAuthenticationAllowableReuseDuration = 0;
    NSError *error = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) {
      reject(@"AUTH_UNAVAILABLE", @"Set a device passcode in Settings to use this action.", error);
      return;
    }

    self.activeContext = context;
    [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
        localizedReason:reason
        reply:^(BOOL success, NSError *evaluationError) {
          dispatch_async(dispatch_get_main_queue(), ^{
            [context invalidate];
            self.activeContext = nil;
            if (success) {
              resolve(nil);
            } else {
              reject(@"AUTH_FAILED", @"Device authentication did not complete.", evaluationError);
            }
          });
        }];
  });
}
@end
