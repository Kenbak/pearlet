#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>

@interface LustreHaptics : NSObject <RCTBridgeModule>
@end

@implementation LustreHaptics

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(trigger:(NSString *)kind)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if ([kind isEqualToString:@"selection"]) {
      UISelectionFeedbackGenerator *generator = [UISelectionFeedbackGenerator new];
      [generator selectionChanged];
    } else if ([kind isEqualToString:@"success"] || [kind isEqualToString:@"warning"] || [kind isEqualToString:@"error"]) {
      UINotificationFeedbackType type = [kind isEqualToString:@"success"] ? UINotificationFeedbackTypeSuccess
        : [kind isEqualToString:@"warning"] ? UINotificationFeedbackTypeWarning
        : UINotificationFeedbackTypeError;
      UINotificationFeedbackGenerator *generator = [UINotificationFeedbackGenerator new];
      [generator notificationOccurred:type];
    } else {
      UIImpactFeedbackStyle style = [kind isEqualToString:@"medium"] ? UIImpactFeedbackStyleMedium
        : [kind isEqualToString:@"soft"] ? UIImpactFeedbackStyleSoft
        : UIImpactFeedbackStyleLight;
      UIImpactFeedbackGenerator *generator = [[UIImpactFeedbackGenerator alloc] initWithStyle:style];
      [generator impactOccurred];
    }
  });
}

@end
