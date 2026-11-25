#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

// Exposes the app's marketing version and build number for Settings > About.
@interface LustreAppInfo : NSObject <RCTBridgeModule>
@end

@implementation LustreAppInfo

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSDictionary *)constantsToExport
{
  NSDictionary *info = [[NSBundle mainBundle] infoDictionary];
  return @{
    @"version": info[@"CFBundleShortVersionString"] ?: @"",
    @"build": info[@"CFBundleVersion"] ?: @"",
  };
}

- (NSDictionary *)getConstants
{
  return [self constantsToExport];
}

@end
