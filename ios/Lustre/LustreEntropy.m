#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <React/RCTBridgeModule.h>

// Random bytes from the system generator, for wallet seeds and signing.
// Fails rather than returning anything weaker.
@interface LustreEntropy : NSObject <RCTBridgeModule>
@end

@implementation LustreEntropy

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(randomBase64:(double)byteLength
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  if (byteLength < 1 || byteLength > 65536 || byteLength != floor(byteLength)) {
    reject(@"ENTROPY_INVALID", @"Invalid entropy length.", nil);
    return;
  }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)byteLength];
  if (data == nil || SecRandomCopyBytes(kSecRandomDefault, data.length, data.mutableBytes) != errSecSuccess) {
    reject(@"ENTROPY_FAILED", @"The device could not provide secure randomness.", nil);
    return;
  }
  NSString *encoded = [data base64EncodedStringWithOptions:0];
  [data resetBytesInRange:NSMakeRange(0, data.length)];
  resolve(encoded);
}

@end
