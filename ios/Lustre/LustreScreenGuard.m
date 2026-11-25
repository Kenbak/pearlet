#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>

// Reports whether the screen is being recorded or mirrored, so a recovery
// phrase can be hidden. iOS has no supported way to block a capture.
@interface LustreScreenGuard : NSObject <RCTBridgeModule>
@end

@implementation LustreScreenGuard

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(setSecure:(BOOL)secure
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  resolve(nil);
}

RCT_EXPORT_METHOD(isCaptured:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    BOOL captured = NO;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if ([scene isKindOfClass:[UIWindowScene class]] && ((UIWindowScene *)scene).screen.isCaptured) {
        captured = YES;
      }
    }
    resolve(@(captured));
  });
}

@end
