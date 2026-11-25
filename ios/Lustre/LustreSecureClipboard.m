#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>

// Copies secrets to the pasteboard for this device only (no Universal
// Clipboard / Handoff) with an expiry, after which iOS removes the item.
@interface LustreSecureClipboard : NSObject <RCTBridgeModule>
@end

@implementation LustreSecureClipboard

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(copySensitive:(NSString *)text
                  seconds:(double)seconds
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (text.length == 0 || seconds <= 0) {
      reject(@"COPY_INVALID", @"Nothing to copy.", nil);
      return;
    }
    NSDate *expiry = [NSDate dateWithTimeIntervalSinceNow:seconds];
    [[UIPasteboard generalPasteboard] setItems:@[@{ @"public.utf8-plain-text": text }]
                                       options:@{
                                         UIPasteboardOptionLocalOnly: @YES,
                                         UIPasteboardOptionExpirationDate: expiry,
                                       }];
    resolve(nil);
  });
}

// An ordinary copy, for public values such as addresses.
RCT_EXPORT_METHOD(setString:(NSString *)text
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [UIPasteboard generalPasteboard].string = text ?: @"";
    resolve(nil);
  });
}

RCT_EXPORT_METHOD(getString:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve([UIPasteboard generalPasteboard].string ?: @"");
  });
}

@end
