const fs = require('fs');

const file =
  './node_modules/react-native/React/Fabric/Mounting/ComponentViews/Modal/RCTModalHostViewComponentView.mm';
const original = `UIViewController *controller = [self reactViewController];
  [controller presentViewController:modalViewController animated:animated completion:completion];`;
const replacement = `UIViewController *controller = [self reactViewController];
  UIViewController *presentedController = controller.presentedViewController;
  while (presentedController != nil && !presentedController.isBeingDismissed) {
    controller = presentedController;
    presentedController = controller.presentedViewController;
  }
  [controller presentViewController:modalViewController animated:animated completion:completion];`;
const content = fs.readFileSync(file, 'utf8');

if (content.includes(replacement)) {
  console.log('Verified React Native multi-modal presentation patch.');
} else if (content.includes(original)) {
  fs.writeFileSync(file, content.replace(original, replacement), 'utf8');
  console.log('Applied React Native multi-modal presentation patch.');
} else {
  throw new Error(`Unable to apply React Native multi-modal patch to ${file}`);
}
