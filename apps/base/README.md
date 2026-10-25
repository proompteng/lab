# Creating a basic S2I builder image

## Getting started

### Files and Directories

| File                   | Required? | Description                                                  |
| ---------------------- | --------- | ------------------------------------------------------------ |
| Dockerfile             | Yes       | Defines the base builder image                               |
| s2i/bin/assemble       | Yes       | Script that builds the application                           |
| s2i/bin/usage          | No        | Script that prints the usage of the builder                  |
| s2i/bin/run            | Yes       | Script that runs the application                             |
| s2i/bin/save-artifacts | No        | Script for incremental builds that saves the built artifacts |
| test/run               | No        | Test script for the builder image                            |
| test/test-app          | Yes       | Test application source code                                 |

#### Dockerfile

Create a _Dockerfile_ that installs all of the necessary tools and libraries that are needed to build and run our application. This file will also handle copying the s2i scripts into the created image.

#### S2I scripts

##### assemble

Create an _assemble_ script that will build our application, e.g.:

- build python modules
- bundle install ruby gems
- setup application specific configuration

The script can also specify a way to restore any saved artifacts from the previous image.

##### run

Create a _run_ script that will start the application.

##### save-artifacts (optional)

Create a _save-artifacts_ script which allows a new build to reuse content from a previous version of the application image.

##### usage (optional)

Create a _usage_ script that will print out instructions on how to use the image.

##### Make the scripts executable

Make sure that all of the scripts are executable by running \*chmod +x s2i/bin/\*\*

#### Create the builder image

The following command will create a builder image named alpine based on the Dockerfile that was created previously.

```bash
docker build -t alpine .
```

The builder image can also be created by using the _make_ command since a _Makefile_ is included.

Once the image has finished building, the command _s2i usage alpine_ will print out the help info that was defined in the _usage_ script.

#### Testing the builder image

The builder image can be tested using the following commands:

```bash
docker build -t alpine-candidate .
IMAGE_NAME=alpine-candidate test/run
```

The builder image can also be tested by using the _make test_ command since a _Makefile_ is included.

#### Creating the application image

The application image combines the builder image with your applications source code, which is served using whatever application is installed via the _Dockerfile_, compiled using the _assemble_ script, and run using the _run_ script.
The following command will create the application image:

```bash
s2i build test/test-app alpine alpine-app
---> Building and installing application from source...
```

Using the logic defined in the _assemble_ script, s2i will now create an application image using the builder image as a base and including the source code from the test/test-app directory.

#### Running the application image

Running the application image is as simple as invoking the docker run command:

```bash
docker run -d -p 8080:8080 alpine-app
```

The application, which consists of a simple static web page, should now be accessible at [http://localhost:8080](http://localhost:8080).

#### Using the saved artifacts script

Rebuilding the application using the saved artifacts can be accomplished using the following command:

```bash
s2i build --incremental=true test/test-app alpine alpine-app
---> Restoring build artifacts...
---> Building and installing application from source...
```

This will run the _save-artifacts_ script which includes the custom code to backup the currently running application source, rebuild the application image, and then re-deploy the previously saved source using the _assemble_ script.
